import '../lib/env.js'; // 加载 .env.local
import fs from 'node:fs';
import { isMock, chat, vision, runtimeConfig } from '../lib/grading/llm.js';

console.log('当前模式:', runtimeConfig().mode);
console.log('isMock:', isMock());
if (isMock()) { console.error('仍是 MOCK —— .env.local 未加载或 Key 缺失'); process.exit(1); }

// 1) 文本模型：真实打分（JSON 返回）
const sys = '你是严谨的助教。只输出 JSON：{"score":number,"note":"简短中文评语"}，不要多余文字。';
const usr = '题目：求 1+1。学生答：等于 2。请评分。';
const t0 = Date.now();
const textRes = await chat({ system: sys, user: usr, temperature: 0.1, expectJson: true });
console.log('\n[文本 hy4-preview] 用时', Date.now() - t0, 'ms');
console.log('  返回:', JSON.stringify(textRes).slice(0, 200));

// 2) 视觉模型：真实图片转写
const imgPath = 'eval/testset/demo-homework.png';
if (fs.existsSync(imgPath)) {
  const b64 = fs.readFileSync(imgPath).toString('base64');
  const v0 = Date.now();
  const vRes = await vision({ prompt: '请转写图中的文字（如无可写内容请说明）', imageBase64: b64, mimeType: 'image/png', timeoutMs: 120000 });
  console.log('\n[视觉 hy-vision-2.0-instruct] 用时', Date.now() - v0, 'ms');
  console.log('  转写:', String(vRes).slice(0, 200));
} else {
  console.log('\n[视觉] 跳过：无 fixture 图');
}

console.log('\n✅ 真实链路验证完成');
