import { gradeAssignment } from '@/lib/grading/pipeline.js';
import { listAssignments } from '@/lib/store/memory.js';

export async function POST(req) {
  try {
    const body = await req.json();
    const { text, assignmentId = 'A1' } = body || {};
    if (!text || !text.trim()) {
      return Response.json({ error: '作业内容为空' }, { status: 400 });
    }
    const assignment = listAssignments().find((a) => a.id === assignmentId) || listAssignments()[0];
    const t0 = Date.now();
    const result = await gradeAssignment({ assignment, studentText: text });
    return Response.json({
      ok: true,
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
