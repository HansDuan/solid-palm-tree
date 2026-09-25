/**
 * 上传接口（C 同学）：文件 / 照片 → 文本 → 落库 → 顺手批改
 *
 * 入参（三选一）：
 *  1. multipart/form-data：可重复字段 file（支持多选/连拍），外加 assignmentId/studentId/studentName/courseHint
 *  2. JSON 单文件：{assignmentId, studentId, studentName, filename, contentBase64}
 *  3. JSON 多文件：{assignmentId, studentId, studentName, files:[{filename, contentBase64}]}
 *
 * 图片走多模态：预处理 → hy-vision-2.0-instruct 分页转录 → 合并 → 同一条证据链批改 pipeline
 */
import { extractFromFiles } from '@/lib/parse/multi.js';
import { saveSubmission, saveGradingResult } from '@/lib/store/repo.js';
import { gradeAssignment } from '@/lib/grading/pipeline.js';
import { listAssignments } from '@/lib/store/memory.js';
import { heapSnapshot } from '@/lib/util/mem.js';

/** 收集一次请求里的所有文件，统一成 [{buffer, filename}] */
async function collectEntries(req) {
  const ct = req.headers.get('content-type') || '';
  const meta = {};
  if (ct.includes('multipart/form-data')) {
    const form = await req.formData();
    meta.assignmentId = form.get('assignmentId');
    meta.studentId = form.get('studentId') || 'unknown';
    meta.studentName = form.get('studentName') || '';
    meta.courseHint = form.get('courseHint') || '';
    const files = form.getAll('file').filter(Boolean);
    const entries = await Promise.all(
      files.map(async (f) => ({
        buffer: Buffer.from(await f.arrayBuffer()),
        filename: f.name || 'upload',
      }))
    );
    return { ...meta, entries };
  }
  const b = await req.json();
  if (Array.isArray(b.files) && b.files.length) {
    return {
      assignmentId: b.assignmentId,
      studentId: b.studentId || 'unknown',
      studentName: b.studentName || '',
      courseHint: b.courseHint || '',
      entries: b.files.map((f) => ({ buffer: Buffer.from((f.contentBase64 || '').split(',').pop() || '', 'base64'), filename: f.filename || 'photo.jpg' })),
    };
  }
  return {
    assignmentId: b.assignmentId,
    studentId: b.studentId || 'unknown',
    studentName: b.studentName || '',
    courseHint: b.courseHint || '',
    entries: [{ buffer: Buffer.from((b.contentBase64 || '').split(',').pop() || '', 'base64'), filename: b.filename || 'upload' }],
  };
}

export async function POST(req) {
  try {
    const { assignmentId, studentId, studentName, courseHint, entries } = await collectEntries(req);
    const kept = entries.filter((e) => e.buffer?.length);
    if (!kept.length) return Response.json({ error: '文件内容为空或全部损坏，请重新选择' }, { status: 400 });

    const extracted = await extractFromFiles(kept, { courseHint });
    const text = extracted.text || '';
    if (!text.trim()) {
      return Response.json(
        {
          error: '未能识别出内容，请重拍一张（正上方俯拍、光线均匀、字迹占画面 2/3 以上）',
          warnings: extracted.warnings,
          pages: extracted.pages?.map((p) => ({ index: p.index, filename: p.filename, ok: !p.error, error: p.error })),
        },
        { status: 422 }
      );
    }

    const sub = saveSubmission({
      assignmentId,
      studentId,
      studentName,
      text,
      filename: kept.map((e) => e.filename).join(' + '),
      source: extracted.source, // file | image | mixed
      pageCount: kept.length,
    });

    const assignment = listAssignments().find((a) => a.id === assignmentId) || listAssignments()[0];
    const result = await gradeAssignment({ assignment, studentText: text });
    const resultId = saveGradingResult({
      submissionId: sub.id,
      assignmentId: assignment.id,
      studentId,
      result,
    });

    return Response.json({
      ok: true,
      submissionId: sub.id,
      resultId,
      filename: kept.map((e) => e.filename).join(' + '),
      source: extracted.source,
      mockTranscript: extracted.mock === true,
      transcript: extracted.transcript,
      charCount: text.length,
      preview: text.slice(0, 200),
      pages: extracted.pages,
      warnings: extracted.warnings,
      elapsedMs: extracted.elapsedMs,
      memory: heapSnapshot(),
      result,
    });
  } catch (e) {
    return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
  }
}
