/**
 * 数据初始化（C 同学）：把作业与学生写进本地库
 * 运行一次即可，重复执行是幂等的（INSERT OR REPLACE）
 */
import { ASSIGNMENTS, STUDENTS } from './memory.js';
import { upsertAssignment, upsertStudents, listAssignmentRows, listStudents } from './repo.js';
import { getDb, storageMode } from './db.js';
import { buildSeededSubmissions, CLUSTER_INDEXES } from './demo-submissions.js';

/**
 * 把全班「真实作答文本」写进 submissions 表（演示用，REAL 数据路径）。
 * 每次启动清空并重写目标作业，保证查重演示可复现、且无历史测试残留。
 */
export function seedSubmissions({ only = null } = {}) {
  const db = getDb();
  const rows = buildSeededSubmissions({ only });
  const assignmentIds = [...new Set(rows.map((r) => r.assignmentId))];
  for (const aid of assignmentIds) {
    try {
      db.run('DELETE FROM submissions WHERE assignment_id = ?', [aid]);
    } catch {
      /* 忽略 */
    }
  }
  let inserted = 0;
  for (const r of rows) {
    try {
      db.run(
        'INSERT OR REPLACE INTO submissions (id, assignment_id, student_id, source, filename, raw_text, created_at) VALUES (?,?,?,?,?,?,?)',
        [`seed_${r.assignmentId}_${r.studentId}`, r.assignmentId, r.studentId, 'seed', 'seed.txt', r.text, new Date().toISOString()]
      );
      inserted++;
    } catch {
      /* 忽略 */
    }
  }
  return { inserted, assignmentIds, clusterSize: CLUSTER_INDEXES.length };
}

export function seed() {
  for (const a of ASSIGNMENTS) upsertAssignment(a);
  upsertStudents(STUDENTS);
  const sub = seedSubmissions();
  return {
    mode: storageMode(),
    assignments: listAssignmentRows().length,
    students: listStudents().length,
    submissions: sub,
  };
}

if (process.argv[1]?.includes('bootstrap')) {
  console.log('数据初始化完成：', seed());
}
