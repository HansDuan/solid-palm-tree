/**
 * 多模态：手写作业照片 → 转录 → 走同一条批改 pipeline
 * 降级路径合规前提下仍可用：识别差即转「AI 转录 + 教师校对 + 批改」
 */
import { vision } from '@/lib/grading/llm.js';
import { TRANSCRIBE_PROMPT } from '@/lib/grading/prompts.js';
import { gradeAssignment } from '@/lib/grading/pipeline.js';
import { listAssignments } from '@/lib/store/memory.js';

export async function POST(req) {
  try {
    const { imageBase64, mimeType = 'image/jpeg', assignmentId = 'A1' } = await req.json();
    if (!imageBase64) return Response.json({ error: '缺少 imageBase64' }, { status: 400 });
    const transcript = await vision({ prompt: TRANSCRIBE_PROMPT, imageBase64, mimeType });
    const assignment = listAssignments().find((a) => a.id === assignmentId) || listAssignments()[0];
    const result = await gradeAssignment({ assignment, studentText: transcript });
    return Response.json({ ok: true, transcript, result });
  } catch (e) {
    return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
  }
}
