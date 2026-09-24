/**
 * 仓储层（C 同学）：作业 / 提交 / 批改结果 / 教师复核 的存取
 * 接口对所有上层保持稳定：无论底层是 SQLite 还是 JSON 快照，调用方式一致。
 */
import { getDb, storageMode } from './db.js';
import { randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();

/* ── 作业 ── */
export function upsertAssignment(a) {
  getDb().run(
    `INSERT OR REPLACE INTO assignments (id, course, title, type, description, rubric_json, answer_key_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      a.id,
      a.course || '',
      a.title || '',
      a.type || 'code',
      a.description || '',
      JSON.stringify(a.rubric || null),
      a.answerKey ? JSON.stringify(a.answerKey) : null,
      now(),
    ]
  );
  return a.id;
}

export function listAssignmentRows() {
  return getDb()
    .all(`SELECT * FROM assignments`)
    .map((r) => ({
      ...r,
      rubric: r.rubric_json ? JSON.parse(r.rubric_json) : null,
      answerKey: r.answer_key_json ? JSON.parse(r.answer_key_json) : null,
    }));
}

/* ── 学生 ── */
export function upsertStudents(students, classId = 'C1') {
  for (const s of students) getDb().run(`INSERT OR REPLACE INTO students (id, name, class_id) VALUES (?, ?, ?)`, [s.id, s.name, classId]);
  return students.length;
}

export function listStudents() {
  return getDb().all(`SELECT * FROM students`);
}

/* ── 提交 ── */
export function saveSubmission({ assignmentId, studentId, studentName, text, filename, source = 'text', pageCount = 1, transcript = null }) {
  const id = `sub_${randomUUID().slice(0, 8)}`;
  getDb().run(
    `INSERT OR REPLACE INTO submissions (id, assignment_id, student_id, source, filename, raw_text, page_count, transcript_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      assignmentId,
      studentId,
      `${source}|${studentName || ''}`,
      filename || '',
      text,
      pageCount,
      transcript ? JSON.stringify(transcript) : null,
      now(),
    ]
  );
  return { id, assignmentId, studentId, source, text, pageCount };
}

export function listSubmissions(assignmentId) {
  return getDb().all(`SELECT * FROM submissions WHERE assignment_id = ?`, [assignmentId]);
}

/* ── 批改结果 ── */
export function saveGradingResult({ submissionId, assignmentId, studentId, result }) {
  const id = `gr_${randomUUID().slice(0, 8)}`;
  getDb().run(
    `INSERT OR REPLACE INTO grading_results (id, submission_id, assignment_id, student_id, total_score, result_json, mode, graded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, submissionId, assignmentId, studentId, result.total_score, JSON.stringify(result), result.mode || 'REAL', now()]
  );
  return id;
}

export function listResults(assignmentId) {
  return getDb()
    .all(`SELECT * FROM grading_results WHERE assignment_id = ?`, [assignmentId])
    .map((r) => ({ ...r, result: JSON.parse(r.result_json) }));
}

export function getResult(submissionId) {
  const r = getDb().get(`SELECT * FROM grading_results WHERE submission_id = ?`, [submissionId]);
  return r ? { ...r, result: JSON.parse(r.result_json) } : null;
}

/* ── 教师复核（人机协同闭环，答辩要用） ── */
export function saveTeacherFeedback({ submissionId, dimension, teacherScore, comment }) {
  const id = `fb_${randomUUID().slice(0, 8)}`;
  getDb().run(
    `INSERT OR REPLACE INTO teacher_feedback (id, submission_id, dimension, teacher_score, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, submissionId, dimension, teacherScore, comment || '', now()]
  );
  return id;
}

export function listFeedback(submissionId) {
  return getDb().all(`SELECT * FROM teacher_feedback WHERE submission_id = ?`, [submissionId]);
}

export { storageMode };
