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
const H = { 'Content-Type': 'application/json', 'x-api-key': KEY, Authorization: `Bearer ${KEY}` };

const a = listAssignments().find((x) => x.id === 'A1');
const rubric = defaultRubric(a.type);
const studentText = `def binary_search(arr, target):
    if not arr: return -1
    left, right = 0, len(arr) - 1
    while left <= right:
        mid = (left + right) // 2
        if arr[mid] == target: return mid
        elif arr[mid] < target: left = mid + 1
        else: right = mid - 1
    return -1
# O(log n)`;
const system = KEY_GRADE_SYSTEM_PROMPT.replace('{TYPE_INSTRUCTION}', typeInstruction(a.type));
const user = buildKeyGradeUser({ rubric, assignment: a, studentText });

async function test(model, mt) {
  const body = {
    model, temperature: 0.1, max_tokens: mt,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
  const t0 = Date.now();
  const r = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const j = await r.json();
  const el = Date.now() - t0;
  const m = j.choices?.[0]?.message || {};
  const c = m.content || '';
  let ok = false;
  try { JSON.parse(c.replace(/^[\s`]*json/, '').replace(/[`]*$/, '').trim()); ok = true; } catch {}
  console.log(`${model} maxT=${mt}`.padEnd(22), el + 'ms', 'finish=' + j.choices?.[0]?.finish_reason, 'reason=' + (m.reasoning_content || '').length, 'contentLen=' + c.length, 'validJSON=' + ok, 'head=' + c.slice(0, 36).replace(/\n/g, ' '));
}

for (const mt of [4096, 6144, 8192]) {
  await test('hy3', mt);
}
