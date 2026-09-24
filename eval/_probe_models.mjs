// 探测 TokenHub 网关可用文本模型 + 各模型响应时延（不打印 Key）
import { readFileSync } from 'node:fs';

function loadEnv() {
  const txt = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  const env = {};
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = loadEnv();
const KEY = env.HUNYUAN_API_KEY;
const BASE = env.HUNYUAN_BASE_URL || 'https://tokenhub.tencentmaas.com/v1';
const headers = { 'Content-Type': 'application/json', 'x-api-key': KEY, Authorization: `Bearer ${KEY}` };

async function listModels() {
  try {
    const r = await fetch(`${BASE}/models`, { headers });
    const j = await r.json().catch(() => null);
    if (j?.data) return j.data.map((m) => m.id || m.name || String(m));
    return `list failed: ${r.status} ${JSON.stringify(j).slice(0, 200)}`;
  } catch (e) {
    return `list error: ${String(e).slice(0, 120)}`;
  }
}

async function testModel(model, timeoutMs = 60000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers,
      signal: ac.signal,
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 200,
        messages: [{ role: 'user', content: '用一句话回答：1+1等于几？只回数字。' }],
      }),
    });
    const el = Date.now() - started;
    const j = await r.json().catch(() => null);
    clearTimeout(t);
    const content = j?.choices?.[0]?.message?.content || '';
    return { model, status: r.status, elapsed: el, content: content.slice(0, 40), ok: r.ok };
  } catch (e) {
    clearTimeout(t);
    return { model, status: 'ERR', elapsed: Date.now() - started, content: String(e.message || e).slice(0, 60), ok: false };
  }
}

console.log('BASE:', BASE);
console.log('--- /models ---');
const models = await listModels();
console.log(JSON.stringify(models).slice(0, 1500));

const candidates = ['hy4-preview', 'hunyuan-turbos', 'hunyuan-turbos-latest', 'hunyuan-standard', 'hunyuan-standard-256K', 'hy3-turbo', 'hunyuan-pro', 'hunyuan-lite'];
console.log('\n--- 时延探测（每个 60s 上限）---');
for (const m of candidates) {
  const r = await testModel(m, 60000);
  console.log(`${r.ok ? 'OK ' : 'XX '} ${m.padEnd(26)} status=${String(r.status).padEnd(4)} ${String(r.elapsed).padStart(6)}ms  ${r.content}`);
}
