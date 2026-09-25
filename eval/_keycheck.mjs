// 一次性真实链路验证：用 .env.local 的 Key 打混元老端点
// ⚠️ 历史诊断脚本：用于验证「旧端点 api.hunyuan.cloud.tencent.com 已下线」这一结论。
//    产品实际端点为 TokenHub（https://tokenhub.tencentmaas.com/v1），模型仅 hy3 + hy-vision-2.0-instruct。
import fs from 'node:fs';

function loadEnv() {
  const raw = fs.readFileSync('.env.local', 'utf8');
  const out = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const env = loadEnv();
const KEY = env.HUNYUAN_API_KEY;
const BASE = env.HUNYUAN_BASE_URL || 'https://tokenhub.tencentcloudmaas.com/v1';
if (!KEY) {
  console.error('未在 .env.local 找到 HUNYUAN_API_KEY —— 先运行 npm run key -- <Key>');
  process.exit(1);
}
console.log('KEY 前缀:', KEY.slice(0, 12) + '...', '长度:', KEY.length);
console.log('BASE:', BASE);

async function chat(model, content, expectText = true) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      temperature: 0.1,
      stream: false,
    }),
  });
  const ms = Date.now() - t0;
  let body;
  try { body = await res.json(); } catch { body = await res.text(); }
  const ok = res.ok && body?.choices?.[0]?.message?.content;
  console.log(`\n[${model}] HTTP ${res.status}  ${ms}ms  返回内容长度: ${ok ? ok.length : 0}`);
  if (!res.ok) {
    console.log('  错误体:', JSON.stringify(body).slice(0, 400));
  } else {
    console.log('  回复预览:', String(ok || '').slice(0, 80).replace(/\n/g, ' '));
  }
  return { ok: !!ok, status: res.status, ms };
}

const text = await chat('hunyuan-turbos', '只回复两个汉字：OK');
console.log('\n=== 文本模型结论:', text.ok ? '✅ 可用' : '❌ 不可用', '===');
process.exit(text.ok ? 0 : 1);
