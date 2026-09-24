// 确认：加上 max_tokens 后 hy4-preview / hy3 都能在合理时延内返回合法 JSON（不打印 Key）
import { readFileSync } from 'node:fs';
import { GRADE_SYSTEM_PROMPT, buildGradeUser } from '../lib/grading/prompts.js';
import { defaultRubric } from '../lib/grading/llm.js';

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
const rubric = defaultRubric('code');
const assignment = { id: 'A1', title: '二分查找', description: '实现 binary_search，分析复杂度' };
const studentText = `def binary_search(arr, target):
    if not arr: return -1
    left, right = 0, len(arr) - 1
    while left <= right:
        mid = (left + right) // 2
        if arr[mid] == target: return mid
        elif arr[mid] < target: left = mid + 1
        else: right = mid - 1
    return -1
# 时间复杂度 O(log n)，空间复杂度 O(1)`;
const system = GRADE_SYSTEM_PROMPT;
const user = buildGradeUser({ rubric, assignment, studentText });

async function test(model, timeoutMs = 60000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify({
        model, temperature: 0.1, max_tokens: 1024,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_object' },
      }),
      signal: ac.signal,
    });
    const el = Date.now() - started;
    const j = await r.json().catch(() => null);
    clearTimeout(t);
    const c = j?.choices?.[0]?.message?.content || '';
    let parsed = null, valid = false;
    try { parsed = JSON.parse(c); valid = true; } catch { valid = false; }
    return { model, status: r.status, el, validJson: valid, total: parsed?.total_score, ok: r.ok };
  } catch (e) {
    clearTimeout(t);
    return { model, status: 'ERR', el: Date.now() - started, validJson: false, total: null, ok: false, err: String(e.message||e).slice(0,40) };
  }
}

for (const m of ['hy4-preview', 'hy3']) {
  const r = await test(m);
  console.log(`${r.ok ? 'OK ' : 'XX '} ${m.padEnd(14)} status=${String(r.status).padEnd(4)} ${String(r.el).padStart(6)}ms  validJSON=${r.validJson}  total_score=${r.total}  ${r.err||''}`);
}
