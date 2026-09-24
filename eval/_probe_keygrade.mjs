// 复现 server 的 gradeWithKey 真实请求（KEY_GRADE prompt + A1 答案键），定位空内容原因（不打印 Key）
import { readFileSync } from 'node:fs';
import { KEY_GRADE_SYSTEM_PROMPT, buildKeyGradeUser } from '../lib/grading/prompts.js';
import { defaultRubric } from '../lib/grading/llm.js';
import { typeInstruction } from '../lib/grading/types.js';
import { listAssignments } from '../lib/store/memory.js';

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

const a = listAssignments().find((x) => x.id === 'A1');
const type = a.type || 'code';
const rubric = a.rubric?.dimensions?.length ? { type, dimensions: a.rubric.dimensions } : defaultRubric(type);
const studentText = `def binary_search(arr, target):
    if not arr: return -1
    left, right = 0, len(arr) - 1
    while left <= right:
        mid = (left + right) // 2
        if arr[mid] == target: return mid
        elif arr[mid] < target: left = mid + 1
        else: right = mid - 1
    return -1
# O(log n)，空间 O(1)`;
const system = KEY_GRADE_SYSTEM_PROMPT.replace('{TYPE_INSTRUCTION}', typeInstruction(type));
const user = buildKeyGradeUser({ rubric, assignment: a, studentText });
console.log(`system=${system.length}字 user=${user.length}字`);

async function test(maxTokens, timeoutMs = 60000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify({
        model: 'hy4-preview', temperature: 0.1, max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_object' },
      }),
      signal: ac.signal,
    });
    const el = Date.now() - started;
    const j = await r.json().catch(() => null);
    clearTimeout(t);
    const c = j?.choices?.[0]?.message?.content;
    console.log(`  maxT=${maxTokens} status=${r.status} ${el}ms contentLen=${c ? c.length : 0} head=${String(c || '').slice(0, 60).replace(/\n/g,' ')}`);
  } catch (e) {
    clearTimeout(t);
    console.log(`  maxT=${maxTokens} ERR ${Date.now() - started}ms ${String(e.message||e).slice(0,50)}`);
  }
}
console.log('--- 复现 server 请求（max_tokens 1500 vs 1024）---');
await test(1500);
await test(1024);
