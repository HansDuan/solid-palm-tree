/**
 * 批量批改自检 + 性能实测：node eval/smoke_batch.mjs
 *
 * 覆盖：启动 30 份 → 结果顺序与花名册一致 → 全部成功 → 逐份落库 → 分布统计 → 取消可用
 * 顺带产出真实耗时数据（可写进作品文档）
 */
import { seed } from '../lib/store/bootstrap.js';
import { listAssignments, getSubmissions } from '../lib/store/memory.js';
import { startBatch, getBatch, cancelBatch, batchSummaryById } from '../lib/grading/batch.js';
import { listResults } from '../lib/store/repo.js';

let pass = 0, total = 0;
const check = (name, ok, extra = '') => {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

console.log('\n=== 批量批改自检（30 人班级） ===\n');
const s = seed();
const assignment = listAssignments()[0];
const rows = getSubmissions(assignment.id);
check('取到班级提交', rows.length >= 30, `${rows.length} 份`);

const inputOrder = rows.map((r) => r.studentId || r.id);
const submissions = rows.map((r) => ({ studentId: r.studentId || r.id, studentName: r.studentName || r.name, text: r.text }));

const t0 = Date.now();
const started = startBatch({ assignment, submissions, concurrency: 3 });
check('任务启动即返回 taskId（不阻塞）', Boolean(started.id) && started.status === 'running', `${started.id} · ${started.total} 份 · 并发 ${started.concurrency}`);

// 轮询等待完成
const deadline = Date.now() + 180000;
let snap = null;
while (Date.now() < deadline) {
  snap = getBatch(started.id, { withResults: true });
  if (snap && snap.status !== 'running') break;
  await new Promise((r) => setTimeout(r, 100));
}
const wall = Date.now() - t0;

check('任务完成', snap && snap.status === 'done', `${snap?.status} · ${wall}ms`);
check('全部批改成功', snap && snap.failed === 0 && snap.ok === snap.total, `成功 ${snap?.ok}/${snap?.total}，失败 ${snap?.failed}`);

const outOrder = (snap?.results || []).map((r) => r.studentId);
const orderKept = outOrder.length === inputOrder.length && outOrder.every((id, i) => id === inputOrder[i]);
check('结果顺序 = 花名册顺序', orderKept, orderKept ? `${outOrder.length} 份对齐` : `期望 ${inputOrder.slice(0, 3)} 实际 ${outOrder.slice(0, 3)}`);

const summary = batchSummaryById(started.id);
const scoresOk = summary && summary.count === snap.total && summary.avg > 0 && summary.avg <= 100;
check('分布统计合理', Boolean(scoresOk), `平均 ${summary?.avg} · 中位 ${summary?.median} · 最高 ${summary?.highest} · 最低 ${summary?.lowest} · 及格率 ${Math.round((summary?.passRate || 0) * 100)}%`);
check('分数有区分度（非全员同分）', Boolean(summary && summary.highest !== summary.lowest), `${summary?.lowest} ~ ${summary?.highest}`);

const dbRows = listResults(assignment.id);
check('逐份落库', dbRows.length >= snap.total, `库内 ${dbRows.length} 条成绩`);
check('总分落在 0–100', (snap?.results || []).every((r) => r.ok === false || (r.total_score >= 0 && r.total_score <= 100)), '全部合规');

/* 取消能力 */
const cancelTask = startBatch({ assignment, submissions: submissions.slice(0, 10), concurrency: 1 });
const cancelled = cancelBatch(cancelTask.id);
check('任务可取消', Boolean(cancelled && cancelled.cancelled === true), `${cancelTask.id}`);

console.log('\n【性能实测】');
console.log(`并发 3 批 ${snap.total} 份：${wall}ms（${(wall / snap.total).toFixed(0)}ms/份）`);
console.log(`待复核维度合计：${summary?.lowConfidenceTotal} 条`);
console.log(`分数分布：${(summary?.distribution || []).map((d) => `${d.range}=${d.count}`).join('  ')}`);
console.log('\n（以上为 MOCK 模式耗时；真实模式耗时取决于混元响应，并发 3 时约 30 份 × 单次延迟 / 3）');

console.log(`\n结果：${pass}/${total} 通过\n`);
process.exit(pass === total ? 0 : 1);
