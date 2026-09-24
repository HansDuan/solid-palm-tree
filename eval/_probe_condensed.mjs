import { readFileSync } from 'node:fs';
import { buildKeyGradeUser } from '../lib/grading/prompts.js';
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
const user = buildKeyGradeUser({ rubric, assignment: a, studentText });

const condensed = `你是严谨的高校助教。结合【标准答案】批改作业，直接输出 JSON，不要输出任何推理过程或前后说明文字。
客观题以标准答案为准逐项核对；主观题以标准答案为参考解，学生用不同但正确的方法也应给分。
输出格式：{"key_match":"full|partial|none","match_detail":"核对结论一句话","total_score":整数,"dimensions":[{"name":"维度名","score":整数,"max":整数,"evidence":"学生原文引用≤60字","reason":"给分理由≤40字","confidence":"high|low"}],"strengths":["优点1"],"improvements":["改进点1"],"comment":"给学生的评语≤120字"}`;

async function test(label, system, mt) {
  const body = {
    model: 'hy4-preview', temperature: 0.1, max_tokens: mt,
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
  console.log(label.padEnd(20), el + 'ms', 'finish=' + j.choices?.[0]?.finish_reason, 'reason=' + (m.reasoning_content || '').length, 'contentLen=' + c.length, 'validJSON=' + ok, 'head=' + c.slice(0, 40).replace(/\n/g, ' '));
}

await test('condensed maxT=2048', condensed, 2048);
await test('condensed maxT=4096', condensed, 4096);
