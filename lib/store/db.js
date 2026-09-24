/**
 * SQLite 数据层（C 同学负责，零第三方依赖：用 Node 内置 node:sqlite）
 * 演示期就用本地单文件 classpilot.db，别碰 MySQL 运维。
 * 若运行环境不支持 node:sqlite，自动降级为「内存 + JSON 快照」，接口完全一致。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data');
const DB_FILE = resolve(DATA_DIR, 'classpilot.db');
const JSON_FILE = resolve(DATA_DIR, 'snapshot.json');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  course TEXT, title TEXT, type TEXT, description TEXT,
  rubric_json TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY, name TEXT, class_id TEXT
);
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  assignment_id TEXT, student_id TEXT, source TEXT,
  filename TEXT, raw_text TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS grading_results (
  id TEXT PRIMARY KEY,
  submission_id TEXT, assignment_id TEXT, student_id TEXT,
  total_score INTEGER, result_json TEXT, mode TEXT, graded_at TEXT
);
CREATE TABLE IF NOT EXISTS teacher_feedback (
  id TEXT PRIMARY KEY,
  submission_id TEXT, dimension TEXT, teacher_score INTEGER, comment TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_gr_assignment ON grading_results(assignment_id);
`;

/* ───────────────── 统一适配层：SQLite / JSON ───────────────── */

class SqliteAdapter {
  constructor(file) {
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
  }
  run(sql, params = []) {
    return this.db.prepare(sql).run(...params);
  }
  all(sql, params = []) {
    return this.db.prepare(sql).all(...params).map((r) => ({ ...r }));
  }
  get(sql, params = []) {
    const r = this.db.prepare(sql).get(...params);
    return r ? { ...r } : null;
  }
  hasColumn(table, col) {
    return this.db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === col);
  }
  addColumn(table, col, type) {
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}

class JsonAdapter {
  constructor(file) {
    this.file = file;
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    this.tables = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  }
  flush() {
    writeFileSync(this.file, JSON.stringify(this.tables, null, 2), 'utf8');
  }
  table(name) {
    this.tables[name] = this.tables[name] || [];
    return this.tables[name];
  }
  run(sql, params = []) {
    // 仅支持本文件用到的三种写入形式
    const m = sql.match(/^INSERT OR REPLACE INTO (\w+)/i) || sql.match(/^INSERT INTO (\w+)/i);
    if (m) {
      const table = this.table(m[1]);
      const cols = sql.match(/\(([^)]*)\)/)[1].split(',').map((s) => s.trim());
      const row = {};
      cols.forEach((c, i) => (row[c] = params[i] ?? null));
      const key = cols[0];
      const idx = table.findIndex((r) => r[key] === row[key]);
      if (idx >= 0) table[idx] = { ...table[idx], ...row };
      else table.push(row);
      this.flush();
      return { changes: 1 };
    }
    if (/^UPDATE (\w+) SET/i.test(sql)) {
      const name = sql.match(/^UPDATE (\w+) SET/i)[1];
      const table = this.table(name);
      const where = sql.match(/WHERE (\w+) = \?/)[1];
      const setCol = sql.match(/SET (\w+) = \?/)[1];
      const row = table.find((r) => r[where] === params[1]);
      if (row) row[setCol] = params[0];
      this.flush();
      return { changes: row ? 1 : 0 };
    }
    return { changes: 0 };
  }
  all(sql, params = []) {
    const m = sql.match(/FROM (\w+)/i);
    const table = this.table(m[1]);
    const w = sql.match(/WHERE (\w+) = \?/);
    return (w ? table.filter((r) => r[w[1]] === params[0]) : table).map((r) => ({ ...r }));
  }
  get(sql, params = []) {
    return this.all(sql, params)[0] || null;
  }
  hasColumn() {
    return true; // JSON 快照是自由 schema，无需迁移
  }
  addColumn() {}
}

/** 增量字段演进：老库文件也能无痛升级，不用删库重来 */
const COLUMN_MIGRATIONS = [
  { table: 'submissions', col: 'page_count', type: 'INTEGER' },
  { table: 'submissions', col: 'transcript_json', type: 'TEXT' },
  { table: 'assignments', col: 'answer_key_json', type: 'TEXT' },
];

let adapter = null;
export function getDb() {
  if (!adapter) {
    adapter = DatabaseSync ? new SqliteAdapter(DB_FILE) : new JsonAdapter(JSON_FILE);
    for (const m of COLUMN_MIGRATIONS) {
      if (!adapter.hasColumn(m.table, m.col)) {
        try {
          adapter.addColumn(m.table, m.col, m.type);
        } catch {
          /* 迁移失败不致命：老字段照常工作 */
        }
      }
    }
  }
  return adapter;
}

export function storageMode() {
  return DatabaseSync ? `SQLite(${DB_FILE})` : `JSON(${JSON_FILE})`;
}
