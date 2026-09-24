# 合成 OCR 自测样本

这批图是**程序渲染的印刷体**，不是真实手写。它的作用只有一个：
验证「上传多张图 → 预处理 → 分页转录 → 合并 → 批改」这条链路是否通畅。

> 最终写进比赛报告的真实识别率，请用 `eval/ocr/` 里的**真实手写照片**跑 `npm run eval:ocr`。

## 用法
```bash
npm run eval:ocr -- --dir eval/ocr-synth
```

## 样本清单（6 个）
- s1-math.jpg (+ .txt)
- s2-code.jpg (+ .txt)
- s3-choice.jpg (+ .txt)
- s4-poor.jpg (+ .txt)
- m1-page1.jpg (+ .txt)
- m1-page2.jpg (+ .txt)

其中 `m1-page1` + `m1-page2` 是一道大题的两页，可用于验证多图合并批改。