// 复现真实批改请求，定位 hy4-preview 超时根因，并对比 hy3（不打印 Key）
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

// 真实 A1 代码作业 + 一份较长学生答案
const rubric = defaultRubric('code');
const assignment = { id: 'A1', title: '二分查找', description: '实现 binary_search，分析复杂度' };
const studentText = `def binary_search(arr, target):
    if not arr:
        return -1
    left, right = 0, len(arr) - 1
    while left <= right:
        mid = (left + right) // 2
        if arr[mid] == target:
            return mid
        elif arr[mid] < target:
            left = mid + 1
        else:
            right = mid - 1
    return -1
# 时间复杂度 O(log n)，空间复杂度 O(1)
# 关键点：循环条件用 <= 避免漏掉单元素；mid 用整数除法防溢出`;

const system = GRADE_SYSTEM_PROMPT;
const user = buildGradeUser({ rubric, assignment, studentText });
console.log(`system 长度=${system.length} 字, user 长度=${user.length} 字`);

async function test(model, { maxTokens, jsonMode, timeoutMs = 90000 }) {
  const body = {
    model,
    temperature: 0.1,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  if (maxTokens) body.max_tokens = maxTokens;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const r = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
    const el = Date.now() - started;
    const j = await r.json().catch(() => null);
    clearTimeout(t);
    const c = j?.choices?.[0]?.message?.content || '';
    return { model, tag: `maxT=${maxTokens || '-'} json=${jsonMode}`, status: r.status, el, head: c.slice(0, 50), ok: r.ok };
  } catch (e) {
    clearTimeout(t);
    return { model, tag: `maxT=${maxTokens || '-'} json=${jsonMode}`, status: 'ERR', el: Date.now() - started, head: String(e.message || e).slice(0, 50), ok: false };
  }
}

console.log('\n=== hy4-preview ===');
for (const v of [
  { maxTokens: null, jsonMode: true },
  { maxTokens: 1024, jsonMode: true },
  { maxTokens: null, jsonMode: false },
]) {
  const r = await test('hy4-preview', v);
  console.log(`  ${r.ok ? 'OK ' : 'XX '} ${r.tag.padEnd(20)} status=${String(r.status).padEnd(4)} ${String(r.el).padStart(6)}ms  ${r.head}`);
}

console.log('\n=== hy3 ===');
for (const v of [
  { maxTokens: 1024, jsonMode: true },
  { maxTokens: null, jsonMode: false },
]) {
  const r = await test('hy3', v);
  console.log(`  ${r.ok ? 'OK ' : 'XX '} ${r.tag.padEnd(20)} status=${String(r.status).padEnd(4)} ${String(r.el).padStart(6)}ms  ${r.head}`);
}
