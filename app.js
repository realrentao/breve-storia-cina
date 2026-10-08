/* ===== Breve storia della Cina · 意中双语朗读阅读器 =====
   数据按需加载版：
     data/book-meta.js  —— 首屏同步加载：meta + 章节目录（无正文），约 18KB
     data/ch/chNN.js    —— 每章正文 + 该章「词 -> IPA」子集，翻到该章时才注入
   相比旧的「book.js 814KB + lexicon.js 265KB 同步加载」，首屏数据量降约 98%。
*/
(function () {
  "use strict";

  const BOOK = window.__BOOK__;
  const ILLUST = window.__ILLUST__ || [];
  if (!BOOK) {
    document.getElementById("content").innerHTML =
      '<p style="color:#c00">数据未加载：请确认 data/book-meta.js 存在。</p>';
    return;
  }

  /* =======================================================
     章节数据按需加载
     ======================================================= */
  const CH_VER = "4";        // 章节数据版本号：正文变动时 +1，用于击穿缓存（index.html 的预载需同步）
  const CH = {};             // ci -> 章数据 {id,title_it,title_zh,paras,lex}
  const PID = {};            // pid -> {ci, pi, para}  ← O(1) 反查，替代原先每帧全表扫描
  const IDX = {};            // 章 id -> ci
  BOOK.chapters.forEach((c, i) => { IDX[c.id] = i; });

  const _waiters = {};
  const _inflight = {};
  const _prefetched = {};

  // 章节脚本回调（data/ch/chNN.js 内容为 window.__CH__("ch00", {...})）
  window.__CH__ = function (id, data) {
    const ci = IDX[id];
    if (ci == null || !data) return;
    CH[ci] = data;
    const ps = data.paras || [];
    for (let pi = 0; pi < ps.length; pi++) {
      PID[ps[pi].id] = { ci: ci, pi: pi, para: ps[pi] };
    }
    _inflight[ci] = false;
    const ws = _waiters[ci];
    delete _waiters[ci];
    if (ws) for (let k = 0; k < ws.length; k++) { try { ws[k](data); } catch (e) { /* noop */ } }
  };

  function loadChapter(ci, cb) {
    const cached = CH[ci];
    if (cached) { if (cb) cb(cached); return; }
    if (cb) (_waiters[ci] = _waiters[ci] || []).push(cb);
    if (_inflight[ci]) return;
    _inflight[ci] = true;
    const s = document.createElement("script");
    s.src = "data/ch/" + BOOK.chapters[ci].id + ".js?v=" + CH_VER;
    s.async = true;
    s.onerror = function () {
      _inflight[ci] = false;
      const ws = _waiters[ci];
      delete _waiters[ci];
      if (ws) for (let k = 0; k < ws.length; k++) { try { ws[k](null); } catch (e) { /* noop */ } }
    };
    document.head.appendChild(s);
  }

  // 空闲时预取相邻章，翻页/连播时零等待
  function prefetchChapter(ci, delay) {
    if (ci < 0 || ci >= BOOK.chapters.length) return;
    if (CH[ci] || _prefetched[ci] || _inflight[ci]) return;
    _prefetched[ci] = true;
    const go = () => loadChapter(ci);
    const idle = () => { if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 2500 }); else go(); };
    if (delay) setTimeout(idle, delay); else idle();
  }

  // Per-chapter illustration tables. Each entry: {file, position: "header"|"inline", after_sentence, pdf_page}
  const illByCh = {};
  ILLUST.forEach((it) => {
    if (!illByCh[it.chapter]) illByCh[it.chapter] = [];
    illByCh[it.chapter].push(it);
  });
  function illustImg(file, alt, isHeader) {
    const wrap = document.createElement("figure");
    wrap.className = "illust";
    const img = document.createElement("img");
    // WebP 体积仅原 PNG 的 ~8%，限宽导出；加载失败回退到原 PNG。
    // 插图复用 russian 站已部署资源（../russian/illustrations-webp/）。
    img.loading = isHeader ? "eager" : "lazy";
    if (isHeader) img.fetchPriority = "high";
    img.decoding = "async";
    const webp = "../russian/illustrations-webp/" + file.replace(/\.png$/i, ".webp");
    const png = "../russian/illustrations/" + file;
    img.src = webp;
    img.onerror = () => { if (img.src.indexOf(".png") < 0) img.src = png; };
    img.alt = alt || "";
    const cap = document.createElement("figcaption");
    cap.className = "illust-cap";
    cap.textContent = "原版插画";
    wrap.appendChild(img);
    wrap.appendChild(cap);
    return wrap;
  }

  const $ = (id) => document.getElementById(id);
  const audio = $("audio");

  /* ---------- 偏好持久化 ---------- */
  const PREF_KEY = "lp_it_prefs_v1";
  const prefs = Object.assign(
    {
      mode: "pair", ipa: true, follow: true, auto: true,
      loop: false,            // 单句循环（跟读用）
      rate: 1, fs: 19, ch: 0
    },
    JSON.parse(localStorage.getItem(PREF_KEY) || "{}")
  );
  const savePrefs = () => localStorage.setItem(PREF_KEY, JSON.stringify(prefs));

  /* ---------- 播放状态 ---------- */
  let curChapter = Math.max(0, Math.min(prefs.ch || 0, BOOK.chapters.length - 1));
  let curPid = null;      // 当前音频段落 id
  let curSi = null;       // 单句点读时的句索引
  let stopAt = null;      // 毫秒；到点停止
  let activeEl = null;
  let playMode = "para";  // "para" = 段落/连读，"sent" = 单句点读
  let playToken = 0;      // 打断令牌：自增即让所有在途的异步播放请求作废
  let pendingSeek = null; // 定位保险：{ms, token, tries}
  let chapterChain = -1;  // 朗读本章：进行中的章索引，>=0 时 ended 自动续播本章下一段
  let wholeChapter = false; // 整章连读模式（一章当作一个段落播放，文案/高亮不显示分段）
  let preAudio = null;      // 预加载的下一音频段，用于段间无缝续播

  // 缓存高频 DOM
  const elSeek = $("seek"), elTCur = $("tCur"), elTDur = $("tDur");
  const elReader = $("reader"), elContent = $("content");

  /* =======================================================
     分词 + 音标渲染（意语音标：逐词查本章词表）
     ======================================================= */
  // 把「前缀标点 + 意语词（含重音字母）+ 后缀标点」拆开，词的下方挂 IPA
  const PART_RE = /^([^À-Ýà-ÿA-Za-z0-9]*)([À-Ýà-ÿA-Za-z]+(?:-[À-Ýà-ÿA-Za-z]+)*|\d+)?([\s\S]*)$/;

  let curLex = {};          // 当前章的「词 -> IPA」表（随章切换）

  function renderIt(text) {
    const frag = document.createDocumentFragment();
    // 按空白切分并保留空白
    const chunks = text.split(/(\s+)/);
    for (const chunk of chunks) {
      if (chunk === "") continue;
      if (/^\s+$/.test(chunk)) {
        frag.appendChild(document.createTextNode(chunk));
        continue;
      }
      const m = chunk.match(PART_RE);
      if (!m || !m[2]) {
        frag.appendChild(document.createTextNode(chunk));
        continue;
      }
      const [, pre, word, post] = m;
      const tok = document.createElement("span");
      tok.className = "tok";
      const wd = document.createElement("span");
      wd.className = "wd";
      wd.textContent = (pre || "") + word + (post || "");
      const ph = document.createElement("span");
      ph.className = "ph";
      ph.textContent = curLex[word.toLowerCase()] || "";
      tok.appendChild(wd);
      tok.appendChild(ph);
      frag.appendChild(tok);
    }
    return frag;
  }

  /* =======================================================
     渲染章节导航（事件委托，DOM 操作从 123×3 降到 2 次批量）
     ======================================================= */
  function renderNav() {
    const nav = $("chapterNav");
    const list = BOOK.chapters;
    let html = "";
    for (let i = 0; i < list.length; i++) html += '<a data-i="' + i + '"><span class="cn-it"></span><span class="cn-zh"></span></a>';
    nav.innerHTML = html;
    const as = nav.children;
    for (let i = 0; i < list.length; i++) {
      as[i].firstChild.textContent = list[i].title_it;
      as[i].lastChild.textContent = list[i].title_zh;
    }
    nav.addEventListener("click", (e) => {
      const a = e.target.closest ? e.target.closest("a[data-i]") : null;
      if (!a) return;
      openChapter(+a.dataset.i);
      closeSidebarOnMobile();
    });
    // 鼠标在目录上停留 140ms 即预取该章，点击时基本已是瞬时
    let navHoverT = 0;
    nav.addEventListener("pointerover", (e) => {
      const a = e.target.closest ? e.target.closest("a[data-i]") : null;
      if (!a) return;
      clearTimeout(navHoverT);
      const i = +a.dataset.i;
      navHoverT = setTimeout(() => prefetchChapter(i), 140);
    });
    nav.addEventListener("pointerout", () => clearTimeout(navHoverT));
    $("bookAuthor").textContent = BOOK.meta.author_it + " · " + BOOK.meta.author_zh;
    const m = BOOK.meta;
    $("sideStats").innerHTML =
      `全书 ${m.n_chapters} 章 · ${m.n_paras} 段 · ${m.n_sents} 句<br>` +
      `配音 ${m.voice}<br>音标：${m.ipa_note}` +
      `<hr class="sf-hr"><b>点读</b>：单击句子 = 只读这一句<br>` +
      `Shift+单击 / <b>⏵起读</b> = 从这句往下连读<br>` +
      `<b>←/→</b> 上一句 / 下一句 · <b>R</b> 重复本句 · <b>空格</b> 播放暂停`;
  }

  let navOn = -1;
  function markNav() {
    const as = $("chapterNav").children;
    if (navOn >= 0 && as[navOn]) as[navOn].classList.remove("on");
    if (as[curChapter]) as[curChapter].classList.add("on");
    navOn = curChapter;
  }

  /* =======================================================
     渲染正文
     ======================================================= */
  let renderSeq = 0;        // 切章令牌：异步加载回来时若已切走则丢弃

  function openChapter(i, keepScroll, onRendered) {
    i = Math.max(0, Math.min(i, BOOK.chapters.length - 1));
    curChapter = i;
    prefs.ch = i;
    savePrefs();
    markNav();
    updateChapterMeta(i);
    if (!keepScroll) elReader.scrollTop = 0;

    const seq = ++renderSeq;
    const cached = CH[i];
    if (cached) {
      renderChapter(i, cached);
      if (onRendered) onRendered(cached);
    } else {
      showChapterLoading(i);
      loadChapter(i, (data) => {
        if (seq !== renderSeq) return;      // 期间已切到别章，丢弃
        if (!data) {
          elContent.textContent = "本章数据加载失败：data/ch/" + BOOK.chapters[i].id + ".js";
          return;
        }
        renderChapter(i, data);
        if (onRendered) onRendered(data);
      });
    }
    prefetchChapter(i + 1, 400);   // 稍作延后，先让首屏/当前章吃满带宽
    if (i > 0) prefetchChapter(i - 1, 1200);
  }

  function updateChapterMeta(i) {
    const list = BOOK.chapters;
    $("btnPrev").disabled = i === 0;
    $("btnNext").disabled = i === list.length - 1;
    $("chapterFootLabel").textContent = list[i].title_it + " · " + list[i].title_zh;
    $("readProgress").textContent = `第 ${i + 1} / ${list.length} 章`;
  }

  function showChapterLoading(i) {
    elContent.textContent = "";
    const d = document.createElement("div");
    d.className = "ch-loading";
    d.textContent = "正在载入 …";
    elContent.appendChild(d);
  }

  function renderChapter(i, ch) {
    curLex = ch.lex || {};
    activeEl = null;          // 旧节点已随重渲染销毁
    elContent.textContent = "";

    const head = document.createElement("div");
    head.className = "chapter-head";
    const h = document.createElement("h1");
    h.className = "ch-it";
    h.textContent = ch.title_it;
    const sub = document.createElement("div");
    sub.className = "ch-zh";
    sub.textContent = ch.title_zh;
    head.appendChild(h);
    head.appendChild(sub);

    // Header illustration for this chapter (position == "header")
    const chIll = illByCh[i] || [];
    const headerIll = chIll.find((x) => x.position === "header");
    if (headerIll) {
      const fig = illustImg(headerIll.file, ch.title_it + " 原版插画", true);
      fig.classList.add("illust-header");
      head.appendChild(fig);
    }

    // 篇/Part 标题横幅：若本章是某「部」开篇，渲染 "PARTE N · 总标题" 于章节标题之上
    if (ch.part_it) {
      const pb = document.createElement("div");
      pb.className = "part-banner";
      const k = document.createElement("div");
      k.className = "pb-kicker";
      k.textContent = ch.part_it;
      const t = document.createElement("div");
      t.className = "pb-title";
      t.textContent = ch.part_title_it || "";
      pb.appendChild(k);
      pb.appendChild(t);
      if (ch.part_title_zh) {
        const z = document.createElement("div");
        z.className = "pb-zh";
        z.textContent = ch.part_title_zh;
        pb.appendChild(z);
      }
      elContent.appendChild(pb);
    }

    elContent.appendChild(head);

    // For inline illustrations, place by per-chapter sentence index
    const inlineIlls = chIll.filter((x) => x.position === "inline");
    // Build a set: after_sentence_idx -> figure
    const inlineBySent = {};
    inlineIlls.forEach((it) => {
      const idx = (typeof it.after_sentence === "number") ? it.after_sentence : 0;
      if (!inlineBySent[idx]) inlineBySent[idx] = [];
      inlineBySent[idx].push(it);
    });
    // Track running global sentence index within this chapter for inline placement
    let runningSentIdx = -1;

    // 一章一整段：所有句子平铺进同一个 .para 容器（视觉上是一段），
    // 但每句仍保留原始段的 data-pid，点读/单句朗读按原段音频工作。
    const div = document.createElement("div");
    div.className = "para para-merged";
    div.dataset.pid = ch.paras[0] ? ch.paras[0].id : "";

    const bar = document.createElement("div");
    bar.className = "para-bar";
    const btn = document.createElement("button");
    btn.className = "para-play";
    btn.textContent = "▶ 朗读本章";
    btn.onclick = (e) => { e.stopPropagation(); playChapter(i); };
    const idx = document.createElement("span");
    idx.className = "para-idx";
    const totalSents = ch.paras.reduce((a, p) => a + p.sents.length, 0);
    idx.textContent = `本章 ${totalSents} 句`;
    bar.appendChild(btn);
    bar.appendChild(idx);
    div.appendChild(bar);

    // 用 DocumentFragment 批量拼装，只触发一次布局
    const frag = document.createDocumentFragment();
    ch.paras.forEach((p, pi) => {
      p.sents.forEach((s, si) => {
        const sd = document.createElement("div");
        sd.className = "sent";
        sd.dataset.pid = p.id;
        sd.dataset.si = si;

        const it = document.createElement("div");
        it.className = "it-line";
        it.appendChild(renderIt(s.it));

        const zh = document.createElement("div");
        zh.className = "zh-line";
        zh.textContent = s.zh || "";

        sd.appendChild(it);
        sd.appendChild(zh);

        if (p.audio && s.t) {
          /* --- 句级操作按钮（悬停浮现） --- */
          const ops = document.createElement("div");
          ops.className = "sent-ops";

          const bSolo = document.createElement("button");
          bSolo.className = "s-btn";
          bSolo.type = "button";
          bSolo.title = "只朗读这一句，读完即停";
          bSolo.textContent = "🔊 单句";
          bSolo.onclick = (e) => { e.stopPropagation(); playSentence(p.id, si, false); };

          const bChain = document.createElement("button");
          bChain.className = "s-btn ghost";
          bChain.type = "button";
          bChain.title = "从这一句开始往下连读";
          bChain.textContent = "⏵ 起读";
          bChain.onclick = (e) => { e.stopPropagation(); playSentence(p.id, si, true); };

          ops.appendChild(bSolo);
          ops.appendChild(bChain);
          sd.appendChild(ops);

          sd.title = "单击：只读这一句　Shift+单击：从这句起连读";
          sd.onclick = (e) => playSentence(p.id, si, e.shiftKey === true);
        } else {
          sd.classList.add("no-audio");
        }

        frag.appendChild(sd);

        // After this sentence, check if any inline illustration should be placed here
        runningSentIdx += 1;
        const illustList = inlineBySent[runningSentIdx];
        if (illustList && illustList.length) {
          illustList.forEach((it) => {
            const fig = illustImg(it.file, ch.title_it + " 插画", false);
            fig.classList.add("illust-inline");
            frag.appendChild(fig);
          });
        }
      });
    });
    div.appendChild(frag);
    elContent.appendChild(div);

    // 重渲染后恢复播放标记
    if (curPid) {
      updateNow(curPid);
      if (playMode === "sent" && curSi !== null) {
        markSolo(curPid, curSi);
        setActive(curPid, curSi);
      }
    }
  }

  /* =======================================================
     播放控制
     ======================================================= */
  function paraById(pid) {
    const e = PID[pid];
    return e ? e.para : null;
  }
  function chapterIdxOfPara(pid) {
    const e = PID[pid];
    return e ? e.ci : -1;
  }

  /* ---------- 打断机制 ----------
     任何新的播放请求都先调用 stopPlayback()：
       1) playToken++ → 所有在途的 loadedmetadata 回调立即作废，不会「抢麦」
       2) 立刻 pause() → 正在播的音频当场停住，不与新音频叠音
  */
  function stopPlayback() {
    playToken++;
    stopAt = null;
    pendingSeek = null;
    chapterChain = -1;            // 任何新播放/打断都终止「朗读本章」状态
    wholeChapter = false;
    preAudio = null;
    if (!audio.paused) { try { audio.pause(); } catch (e) { /* noop */ } }
  }

  function safePlay() {
    const pr = audio.play();
    // 被后续播放请求打断时浏览器抛 AbortError，静默忽略
    if (pr && typeof pr.catch === "function") pr.catch(() => {});
  }

  /* 定位到指定毫秒。
     某些环境（服务端 Range 支持不全 / 缓冲未就绪）第一次 seek 会被忽略而
     退回 0 秒，故记录目标位置并在 canplay/playing/seeked 时校正重试。 */
  function seekTo(ms) {
    pendingSeek = { ms: ms, token: playToken, tries: 0 };
    try { audio.currentTime = ms / 1000; } catch (e) { /* noop */ }
  }

  function fixSeek() {
    if (!pendingSeek) return;
    if (pendingSeek.token !== playToken) { pendingSeek = null; return; }
    const off = Math.abs(audio.currentTime * 1000 - pendingSeek.ms);
    if (off > 400 && pendingSeek.tries < 6) {
      pendingSeek.tries++;
      try { audio.currentTime = pendingSeek.ms / 1000; } catch (e) { /* noop */ }
    } else if (off <= 400) {
      pendingSeek = null;
    }
  }
  audio.addEventListener("canplay", fixSeek);
  audio.addEventListener("playing", fixSeek);
  audio.addEventListener("seeked", fixSeek);
  audio.addEventListener("timeupdate", fixSeek);

  function ensureSrc(pid, cb) {
    const token = playToken;
    const run = () => { if (token === playToken) cb(); };

    // 同一段落且元数据已就绪 → 直接复用，可立即 seek
    if (curPid === pid && audio.src && audio.readyState >= 1) { run(); return; }

    curPid = pid;
    audio.src = "audio/" + pid + ".mp3";

    const cleanup = () => {
      audio.removeEventListener("loadedmetadata", onReady);
      audio.removeEventListener("error", onErr);
    };
    const onReady = () => { cleanup(); run(); };
    const onErr = () => {
      cleanup();
      if (token !== playToken) return;
      $("nowSub").textContent = "音频加载失败：audio/" + pid + ".mp3";
    };
    audio.addEventListener("loadedmetadata", onReady);
    audio.addEventListener("error", onErr);
    audio.load();
  }

  function applyRate() {
    audio.playbackRate = prefs.rate;
    // 变速不变调
    audio.preservesPitch = true;
    audio.mozPreservesPitch = true;
    audio.webkitPreservesPitch = true;
  }

  /* 整段（或从段中某处）连读；whole=true 表示「整章连读」模式
     （一章当作一个段落，段间无缝续播，文案/高亮不显示分段） */
  function playParagraph(pid, fromMs, whole) {
    stopPlayback();
    playMode = "para";
    curSi = null;
    markSolo(null, null);
    if (whole) { chapterChain = chapterIdxOfPara(pid); wholeChapter = true; }
    ensureSrc(pid, () => {
      audio.currentTime = (fromMs || 0) / 1000;
      stopAt = null;
      applyRate();
      safePlay();
      updateNow(pid);
    });
    if (whole) preloadNextPara(pid);   // 预载下一段，段尾无缝续播
  }

  /* 同章内当前段的下一音频段 id（用于预加载） */
  function nextParaInChapter(pid) {
    const e = PID[pid];
    if (!e) return null;
    const ch = CH[e.ci];
    if (!ch) return null;
    for (let k = e.pi + 1; k < ch.paras.length; k++)
      if (ch.paras[k].audio) return ch.paras[k].id;
    return null;
  }
  function preloadNextPara(pid) {
    const nx = nextParaInChapter(pid);
    preAudio = null;
    if (!nx) return;
    preAudio = new Audio();
    preAudio.preload = "auto";
    preAudio.src = "audio/" + nx + ".mp3";
  }

  /* 朗读整个章节：从本章第一段起连读，段尾自动续下一段直到本章结束 */
  function playChapter(ci) {
    loadChapter(ci, (ch) => {
      if (!ch || ci !== curChapter) return;
      const first = ch.paras.find((p) => p.audio);
      if (!first) return;
      chapterChain = ci;            // 标记：ended 时自动续读本章下一段
      wholeChapter = true;
      playParagraph(first.id, 0, true);
    });
  }

  /* 计算某 pid+段内句序号 在章内的全局句序号，用于「本章第 X 句」文案 */
  function chapterSentInfo(pid, siInPara) {
    const e = PID[pid];
    const ch = e ? CH[e.ci] : null;
    if (!ch) return { globalIdx: 0, total: 0 };
    let acc = 0;
    for (let k = 0; k < e.pi; k++) acc += ch.paras[k].sents.length;
    const total = ch.paras.reduce((a, p) => a + p.sents.length, 0);
    return { globalIdx: acc + (siInPara != null ? siInPara : 0) + 1, total };
  }

  /* 点读单句
     chain = false → 只读这一句，到句尾立即停（可配合「单句循环」重复）
     chain = true  → 从这一句开始往下连读                                */
  function playSentence(pid, si, chain) {
    const p = paraById(pid);
    if (!p || !p.audio) return;
    const s = p.sents[si];
    if (!s || !s.t) return;

    stopPlayback();                       // ← 打断：作废在途请求 + 停掉在播音频
    playMode = chain ? "para" : "sent";
    curSi = chain ? null : si;

    // 视觉反馈同步给出，不等音频加载
    markSolo(chain ? null : pid, si);
    setActive(pid, si);

    ensureSrc(pid, () => {
      audio.currentTime = s.t[0] / 1000;
      stopAt = chain ? null : s.t[1];
      applyRate();
      safePlay();
      updateNow(pid);
    });
  }

  function currentSentence() {
    if (curSi === null || !curPid) return null;
    const p = paraById(curPid);
    return p ? p.sents[curSi] : null;
  }

  /* 重复朗读当前句（未处于单句模式时取当前高亮句） */
  function replaySentence() {
    if (curPid && curSi !== null) return playSentence(curPid, curSi, false);
    if (activeEl) return playSentence(activeEl.dataset.pid, +activeEl.dataset.si, false);
    // 都没有 → 读本章第一句
    const ch = CH[curChapter];
    const p = ch && ch.paras.find((x) => x.audio);
    if (p) playSentence(p.id, 0, false);
  }

  /* 上一句 / 下一句 点读（可跨段落，在本章内移动） */
  function stepSentence(delta) {
    let pid = curPid, si = curSi;
    if (pid == null || si == null) {
      if (activeEl) { pid = activeEl.dataset.pid; si = +activeEl.dataset.si; }
      else {
        const ch0 = CH[curChapter];
        const p0 = ch0 && ch0.paras.find((x) => x.audio);
        if (!p0) return;
        pid = p0.id;
        si = delta > 0 ? -1 : 0;
      }
    }
    const ci = chapterIdxOfPara(pid);
    if (ci < 0) return;
    const ch = CH[ci];
    if (!ch) return;
    let pi = PID[pid].pi;
    let t = si + delta;
    let guard = 0;
    while (guard++ < 5000) {
      const p = ch.paras[pi];
      if (!p) return;
      if (t >= 0 && t < p.sents.length) {
        if (p.audio && p.sents[t].t) {
          if (ci !== curChapter) openChapter(ci, true);
          playSentence(p.id, t, false);
          scrollToSent(p.id, t);
          return;
        }
        t += delta;
        continue;
      }
      if (t < 0) {
        pi--;
        if (pi < 0) return;
        t = ch.paras[pi].sents.length - 1;
      } else {
        pi++;
        if (pi >= ch.paras.length) return;
        t = 0;
      }
    }
  }

  function scrollToSent(pid, si) {
    const el = document.querySelector(`.sent[data-pid="${pid}"][data-si="${si}"]`);
    if (!el) return;
    const r = elReader.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    if (b.top < r.top + 60 || b.bottom > r.bottom - 60)
      el.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function setActive(pid, si) {
    const el = document.querySelector(`.sent[data-pid="${pid}"][data-si="${si}"]`);
    if (!el) return;
    if (activeEl && activeEl !== el) activeEl.classList.remove("active");
    activeEl = el;
    el.classList.add("active");
  }

  function markSolo(pid, si) {
    document.querySelectorAll(".sent.solo").forEach((e) => e.classList.remove("solo"));
    if (pid == null) return;
    const el = document.querySelector(`.sent[data-pid="${pid}"][data-si="${si}"]`);
    if (el) el.classList.add("solo");
  }

  let paraEl = null;   // 当前章的 .para 容器（整章合并后仅一个）
  function updateNow(pid) {
    const e = PID[pid];
    const ci = e ? e.ci : -1;
    const ch = e ? CH[ci] : null;
    const p = e ? e.para : null;
    const pi = e ? e.pi : -1;
    $("nowTitle").textContent = ch ? `${ch.title_it} · ${ch.title_zh}` : "";
    let sub;
    if (wholeChapter && chapterChain >= 0) {
      // 整章连读：不显示「第几段」，统一为「朗读本章 · 本章 N 句」
      const info = chapterSentInfo(pid, null);
      sub = `朗读本章 · 本章 ${info.total} 句`;
    } else if (playMode === "sent" && curSi !== null) {
      sub = `第 ${pi + 1} / ${ch.paras.length} 段 · 单句点读 第 ${curSi + 1} 句`;
      if (prefs.loop) sub += "（循环）";
    } else {
      sub = `第 ${pi + 1} / ${ch.paras.length} 段 · ${p.sents.length} 句`;
    }
    $("nowSub").textContent = sub;
    // 高亮：整章连读时锁定整个 .para-merged（一章一整体），否则按 pid 切
    document.querySelectorAll(".para").forEach((d) =>
      d.classList.toggle("playing", wholeChapter ? true : d.dataset.pid === pid)
    );
  }

  /* 段落播完 → 自动接下一段 / 下一章（跨章用 meta.first_pid，无需预载整本） */
  function nextParagraph() {
    const e = PID[curPid];
    if (!e) return null;
    const ch = CH[e.ci];
    if (ch) {
      for (let k = e.pi + 1; k < ch.paras.length; k++)
        if (ch.paras[k].audio) return { ci: e.ci, pid: ch.paras[k].id };
    }
    for (let c = e.ci + 1; c < BOOK.chapters.length; c++)
      if (BOOK.chapters[c].first_pid) return { ci: c, pid: BOOK.chapters[c].first_pid };
    return null;
  }

  audio.addEventListener("ended", () => {
    // 单句点读：句尾恰好是段尾时会触发 ended，此处不得续读下一段
    if (playMode === "sent") {
      if (prefs.loop && curPid && curSi !== null) {
        playSentence(curPid, curSi, false);
      } else {
        setPlayIcon(false);
      }
      return;
    }
    if (!prefs.auto && chapterChain < 0) { setPlayIcon(false); return; }
    // 朗读本章：自动续播本章的下一段（同一章内跨段连读，无缝衔接）
    if (chapterChain >= 0 && chapterChain === curChapter) {
      const ch = CH[curChapter];
      let pi = ch ? ch.paras.findIndex((p) => p.id === curPid) : -1;
      while (ch && pi + 1 < ch.paras.length) {
        pi++;
        if (ch.paras[pi].audio) {
          // 不 reset playToken/wholeChapter，整章视为一个段落
          wholeChapter = true;
          playParagraph(ch.paras[pi].id, 0, true);
          return;
        }
      }
      chapterChain = -1;            // 本章已读完
      wholeChapter = false;
      setPlayIcon(false);
      return;
    }
    if (!prefs.auto) { setPlayIcon(false); return; }
    const nx = nextParagraph();
    if (!nx) { setPlayIcon(false); return; }
    if (nx.ci !== curChapter) openChapter(nx.ci);
    loadChapter(nx.ci, () => playParagraph(nx.pid, 0));
  });

  audio.addEventListener("play", () => setPlayIcon(true));
  audio.addEventListener("pause", () => setPlayIcon(false));

  function setPlayIcon(playing) {
    $("playIcon").textContent = playing ? "❙❙" : "▶";
  }

  /* ---------- 进度 / 高亮 ---------- */
  let seeking = false;
  function fmt(t) {
    if (!isFinite(t)) return "0:00";
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ":" + String(s).padStart(2, "0");
  }

  function tick() {
    if (!audio.paused && curPid) {
      const ms = audio.currentTime * 1000;
      if (stopAt !== null && ms >= stopAt) {
        const s = playMode === "sent" ? currentSentence() : null;
        if (s && s.t && prefs.loop) {
          audio.currentTime = s.t[0] / 1000;   // 单句循环：回到句首继续
        } else {
          audio.pause();
          stopAt = null;
        }
      } else if (playMode !== "sent") {
        // 单句点读时高亮已锁定，无需按时间戳追随（避免抖动）
        highlight(ms);
      }
    }
    if (!seeking && audio.duration) {
      elSeek.value = Math.round((audio.currentTime / audio.duration) * 1000);
      elTCur.textContent = fmt(audio.currentTime);
      elTDur.textContent = fmt(audio.duration);
    }
    requestAnimationFrame(tick);
  }

  function highlight(ms) {
    const p = paraById(curPid);
    if (!p) return;
    let idx = -1;
    for (let i = 0; i < p.sents.length; i++) {
      const t = p.sents[i].t;
      if (t && ms >= t[0] && ms < t[1]) { idx = i; break; }
    }
    if (idx < 0) return;
    const el = document.querySelector(
      `.sent[data-pid="${curPid}"][data-si="${idx}"]`
    );
    if (!el || el === activeEl) {
      if (wholeChapter) updateWholeSub(idx);
      return;
    }
    if (activeEl) activeEl.classList.remove("active");
    activeEl = el;
    el.classList.add("active");
    if (wholeChapter) updateWholeSub(idx);
    if (prefs.follow) {
      const r = elReader.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      if (b.top < r.top + 60 || b.bottom > r.bottom - 60) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }

  function updateWholeSub(siInPara) {
    const info = chapterSentInfo(curPid, siInPara);
    $("nowSub").textContent = `朗读本章 · 本章第 ${info.globalIdx} / ${info.total} 句`;
    if (paraEl) paraEl.classList.add("playing");
  }
  requestAnimationFrame(tick);

  /* =======================================================
     控件绑定
     ======================================================= */
  $("btnPlay").onclick = () => {
    if (audio.paused) {
      if (!curPid) {
        const ch = CH[curChapter];
        const p = ch && ch.paras.find((x) => x.audio);
        if (p) playParagraph(p.id, 0);
        return;
      }
      if (playMode === "sent" && curSi !== null) {
        const s = currentSentence();
        if (s && s.t) {
          // 已读到句尾 → 从句首重播；否则续读到句尾
          if (audio.currentTime * 1000 >= s.t[1] - 40)
            audio.currentTime = s.t[0] / 1000;
          stopAt = s.t[1];
          applyRate();
          safePlay();
          return;
        }
      }
      stopAt = null;
      applyRate();
      safePlay();
    } else audio.pause();
  };

  $("btnRepeat").onclick = () => replaySentence();
  $("btnPrevSent").onclick = () => stepSentence(-1);
  $("btnNextSent").onclick = () => stepSentence(1);

  const seek = elSeek;
  seek.addEventListener("input", () => { seeking = true; });
  seek.addEventListener("change", () => {
    if (audio.duration) {
      audio.currentTime = (seek.value / 1000) * audio.duration;
      // 手动拖动 → 退出单句点读，转为连读
      stopAt = null;
      playMode = "para";
      curSi = null;
      markSolo(null, null);
      if (curPid) updateNow(curPid);
    }
    seeking = false;
  });

  const rate = $("rate");
  function setRate(v) {
    prefs.rate = Math.min(2, Math.max(0.5, +v));
    rate.value = prefs.rate;
    $("rateVal").textContent = prefs.rate.toFixed(2) + "×";
    applyRate();
    savePrefs();
  }
  rate.addEventListener("input", () => setRate(rate.value));
  $("btnRateReset").onclick = () => setRate(1);

  // 显示模式
  function setMode(m) {
    prefs.mode = m;
    document.body.classList.remove("mode-pair", "mode-col", "mode-it", "mode-zh");
    document.body.classList.add("mode-" + m);
    [...$("modeSeg").children].forEach((b) =>
      b.classList.toggle("on", b.dataset.mode === m)
    );
    savePrefs();
  }
  [...$("modeSeg").children].forEach((b) => {
    b.onclick = () => setMode(b.dataset.mode);
  });

  // 音标 / 滚动 / 连续 / 单句循环
  $("chkIpa").onchange = (e) => {
    prefs.ipa = e.target.checked;
    document.body.classList.toggle("no-ipa", !prefs.ipa);
    savePrefs();
  };
  $("chkFollow").onchange = (e) => { prefs.follow = e.target.checked; savePrefs(); };
  $("chkAuto").onchange = (e) => { prefs.auto = e.target.checked; savePrefs(); };
  $("chkLoop").onchange = (e) => {
    prefs.loop = e.target.checked;
    savePrefs();
    if (curPid) updateNow(curPid);
  };

  // 字号
  function setFs(v) {
    prefs.fs = Math.min(30, Math.max(14, v));
    document.documentElement.style.setProperty("--fs", prefs.fs + "px");
    savePrefs();
  }
  $("btnFontUp").onclick = () => setFs(prefs.fs + 1);
  $("btnFontDn").onclick = () => setFs(prefs.fs - 1);

  // 章节翻页
  $("btnPrev").onclick = () => openChapter(curChapter - 1);
  $("btnNext").onclick = () => openChapter(curChapter + 1);

  // 侧栏
  $("btnMenu").onclick = () => {
    $("sidebar").classList.toggle("hidden");
    if (window.innerWidth <= 900)
      $("overlay").classList.toggle("on", !$("sidebar").classList.contains("hidden"));
  };
  $("overlay").onclick = () => {
    $("sidebar").classList.add("hidden");
    $("overlay").classList.remove("on");
  };
  function closeSidebarOnMobile() {
    if (window.innerWidth <= 900) {
      $("sidebar").classList.add("hidden");
      $("overlay").classList.remove("on");
    }
  }

  /* 快捷键：空格 播放暂停 · ←/→ 上下句点读 · R 重复本句 */
  document.addEventListener("keydown", (e) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.code === "Space") { e.preventDefault(); $("btnPlay").onclick(); return; }
    if (e.code === "ArrowRight") { e.preventDefault(); stepSentence(1); return; }
    if (e.code === "ArrowLeft") { e.preventDefault(); stepSentence(-1); return; }
    if (e.key === "r" || e.key === "R") { e.preventDefault(); replaySentence(); return; }
  });

  /* =======================================================
     初始化
     ======================================================= */
  renderNav();
  setMode(prefs.mode);
  setFs(prefs.fs);
  setRate(prefs.rate);
  $("chkIpa").checked = prefs.ipa;
  document.body.classList.toggle("no-ipa", !prefs.ipa);
  $("chkFollow").checked = prefs.follow;
  $("chkAuto").checked = prefs.auto;
  $("chkLoop").checked = prefs.loop;
  if (window.innerWidth <= 900) $("sidebar").classList.add("hidden");
  openChapter(curChapter, false, () => { paraEl = elContent.querySelector(".para-merged"); });
})();
