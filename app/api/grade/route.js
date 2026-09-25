import { gradeAssignment } from '@/lib/grading/pipeline.js';
import { listAssignments } from '@/lib/store/memory.js';
import { saveSubmission, saveGradingResult } from '@/lib/store/repo.js';

export async function POST(req) {
  try {
    const body = await req.json();
    const { text, assignmentId = 'A1', studentId, studentName } = body || {};
    if (!text || !text.trim()) {
      return Response.json({ error: '作业内容为空' }, { status: 400 });
    }
    const assignment = listAssignments().find((a) => a.id === assignmentId) || listAssignments()[0];
    const t0 = Date.now();
    const result = await gradeAssignment({ assignment, studentText: text });
    // 批改完成即落一条真实提交（与 /api/upload、/api/grade/async 行为一致），回带 submissionId 供教师复核闭环
    const sub = saveSubmission({
      assignmentId: assignment.id,
      studentId: studentId || ('stu_local_' + Date.now().toString(36)),
      studentName: studentName || '',
      text: text || '',
      source: 'text',
      pageCount: 1,
    });
    saveGradingResult({ submissionId: sub.id, assignmentId: assignment.id, studentId: sub.studentId, result });
    return Response.json({
      ok: true,
      submissionId: sub.id,
      elapsedMs: Date.now() - t0,
      assignment: { id: assignment.id, title: assignment.title },
      result,
    });
  } catch (e) {
    return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
  }
}

export async function GET() {
  return Response.json({ assignments: listAssignments() });
}
