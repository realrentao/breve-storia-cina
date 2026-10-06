# Breve storia della Cina · 中国简史 — 意中双语朗读阅读器

基于 Andrea Marrone《Breve storia della Cina》的意中对照学习站点。

## 功能
- **逐词 IPA 音标**：11,373 词条，意大利语宽式音位转写
- **逐句对照**：意大利语原文 + 中文翻译
- **真人配音**：edge-tts `it-IT-DiegoNeural`，925 段逐词时间戳
- **四种阅读模式**：逐句对照 / 双栏 / 仅意语 / 仅中文
- **整章连读 + 点读**：章内逐句播放、逐词高亮
- **123 章**完整目录

## 数据
- `data/book.js` — `window.__BOOK__`（meta + chapters）
- `data/lexicon.js` — `window.__LEX__`（word → IPA）
- `data/illust.js` — `window.__ILLUST__`（本版无插画）

## 音频
`audio/{paraId}.mp3` + `audio/{paraId}.json`（逐词时间戳）

## 许可
原文版权归属原著者与出版方，本仓库仅作个人学习用途。
