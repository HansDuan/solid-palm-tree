/**
 * 效果回归评测：node eval/run_eval.mjs
 * 指标：① 评分一致性（3 次分差 ≤5%）② 评分准确度 MAE（≤8 分）③ JSON 解析成功率（≥95%）
 *      ④ 证据可定位率（evidence 必须能在原文中找到）
 * MOCK 模式下 ①②无效（规则模拟必然一致），仅验证 ③④ 与全链路连通性。
 */
import '../lib/env.js'; // 加载 .env.local，使真实模式在纯 Node 评测脚本下也能激活
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeAssignment } from '../lib/grading/pipeline.js';
import { currentMode } from '../lib/grading/llm.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(resolve(root, 'eval/testset/samples.json'), 'utf8'));
const TIMES = 3;

let parseOk = 0,
  parseTotal = 0;
const rows = [];

for (const s of data.samples) {
  const scores = [];
  let evidenceRate = 0;
  for (let i = 0; i < TIMES; i++) {
    parseTotal++;
    try {
      const r = await gradeAssignment({ assignment: s.assignment, studentText: s.text });
      parseOk++;
      scores.push(r.total_score);
      // 证据可定位：high 置信度的证据必须是原文子串
      const high = r.dimensions.filter((d) => d.confidence === 'high');
      const located = high.filter((d) => s.text.includes(d.evidence)).length;
      evidenceRate = high.length ? located / high.length : 1;
    } catch (e) {
      scores.push(null);
    }
  }
  const valid = scores.filter((x) => x !== null);
  const spread = valid.length ? (Math.max(...valid) - Math.min(...valid)) / 100 : 1;
  const avg = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
  const mae = valid.length ? Math.abs(avg - s.human_total) : null;
  rows.push({
    id: s.id,
    type: s.type,
    human: s.human_total,
    ai: valid.length ? Math.round(avg) : 'ERROR',
    mae: mae === null ? '-' : mae.toFixed(1),
    spread: `${(spread * 100).toFixed(1)}%`,
    passSpread: spread <= 0.05,
    evidence: `${(evidenceRate * 100).toFixed(0)}%`,
  });
}

const parseRate = parseOk / parseTotal;
const maeList = rows.filter((r) => r.mae !== '-').map((r) => Number(r.mae));
const avgMae = maeList.length ? (maeList.reduce((a, b) => a + b, 0) / maeList.length).toFixed(1) : '-';
const mode = currentMode();

const pad = (s, n) => String(s).padEnd(n, ' ');
console.log(`\n=== ClassPilot 批改评测  mode=${mode}  samples=${rows.length} ===\n`);
console.log(pad('ID', 6) + pad('类型', 10) + pad('人工分', 8) + pad('AI分', 8) + pad('MAE', 8) + pad('分差', 8) + '证据定位');
console.log('-'.repeat(58));
for (const r of rows) {
  console.log(
    pad(r.id, 6) + pad(r.type, 10) + pad(r.human, 8) + pad(r.ai, 8) + pad(r.mae, 8) + pad(r.spread, 8) + r.evidence
  );
}
console.log('-'.repeat(58));
console.log(`JSON 解析成功率: ${(parseRate * 100).toFixed(1)}%  (目标 ≥95%)`);
console.log(`平均 MAE: ${avgMae}  (目标 ≤8，MOCK 模式仅供参考)`);

const report = { time: new Date().toISOString(), mode, parseRate: +parseRate.toFixed(3), avgMae, rows };
try {
  writeFileSync(resolve(root, 'eval/report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('\n报告已写入 eval/report.json\n');
} catch (e) {
  // 沙箱/权限导致写盘失败时不影响已打印的指标
  console.log(`\n(eval/report.json 写入失败: ${e.code || e.message}，指标见上方输出)\n`);
}
