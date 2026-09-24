/**
 * 批量批改接口：一次批完整个班（30 份）
 *
 * POST /api/grade/batch   {assignmentId, concurrency?, limit?, source?}  → 启动，返回 taskId
 * GET  /api/grade/batch?id=xxx            → 进度快照
 * GET  /api/grade/batch?id=xxx&full=1     → 含每份明细
 * GET  /api/grade/batch                   → 最近任务列表
 * POST /api/grade/batch {action:'cancel', id}  → 取消
 */
import { startBatch, getBatch, listBatches, cancelBatch, batchSummaryById } from '@/lib/grading/batch.js';
import { listAssignments, getSubmissions } from '@/lib/store/memory.js';
import { listSubmissions } from '@/lib/store/repo.js';

function collectSubmissions({ assignmentId, source = 'class', limit }) {
  if (source === 'db') {
    const rows = listSubmissions(assignmentId);
    return rows.map((r, i) => ({
      studentId: r.student_id,
      studentName: String(r.source || '').split('|')[1] || '',
      text: r.raw_text || '',
      submissionId: r.id,
    }));
  }
  // 默认取虚拟班级（30 人）——演示与压测都用它
  const rows = getSubmissions(assignmentId);
  return (limit ? rows.slice(0, limit) : rows).map((s) => ({
    studentId: s.studentId || s.id,
    studentName: s.studentName || s.name,
    text: s.text,
  }));
}

export async function POST(req) {
  try {
    const b = await req.json().catch(() => ({}));
    if (b.action === 'cancel') {
      const t = cancelBatch(b.id);
      return Response.json(t ? { ok: true, task: t } : { ok: false, error: '任务不存在' }, { status: t ? 200 : 404 });
    }
    const assignmentId = b.assignmentId || listAssignments()[0]?.id;
    const assignment = listAssignments().find((a) => a.id === assignmentId) || listAssignments()[0];
    const submissions = collectSubmissions({ assignmentId, source: b.source, limit: b.limit });
    if (!submissions.length) {
      return Response.json({ ok: false, error: `作业 ${assignmentId} 没有可批改的提交` }, { status: 400 });
    }
    const task = startBatch({ assignment, submissions, concurrency: b.concurrency });
    return Response.json({ ok: true, taskId: task.id, total: task.total, concurrency: task.concurrency, assignment });
  } catch (e) {
    return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
  }
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return Response.json({ ok: true, tasks: listBatches() });
  const full = searchParams.get('full') === '1';
  const t = getBatch(id, { withResults: full });
  if (!t) return Response.json({ ok: false, error: '任务不存在' }, { status: 404 });
  return Response.json({
    ok: true,
    task: t,
    summary: t.status === 'done' || t.status === 'cancelled' ? batchSummaryById(id) : null,
  });
}
