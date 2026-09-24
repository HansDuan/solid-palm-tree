/**
 * 批量批改任务（D7 核心）
 *
 * 为什么要单独做一层，而不是直接用 pipeline.gradeBatch：
 *  1. **结果顺序**：老师看到的名单顺序必须和花名册一致。原来 gradeBatch 是「谁先跑完谁先 push」，
 *     并发下顺序是乱的——成绩出来要人工对着学号重排，这在演示现场是硬伤。
 *  2. **进度可查**：30 份批改真实模式要跑 1–2 分钟，前端必须能轮询进度，不能干等一个空白页。
 *  3. **失败可重试**：单份失败不影响整批，且每份自带 2 次机会；失败原因逐条留痕，方便复盘。
 *  4. **可取消**：演示时临时想换作业，能立刻停掉而不是让 30 个请求继续烧额度。
 */
import { randomUUID } from 'node:crypto';
import { gradeAssignment } from './pipeline.js';
import { saveGradingResult } from '../store/repo.js';

const tasks = new Map();
const MAX_ATTEMPTS = Number(process.env.GRADE_MAX_ATTEMPTS || 2);
const DEFAULT_CONCURRENCY = Number(process.env.GRADE_CONCURRENCY || 3);
const MAX_CONCURRENCY = 8;

/** 受控并发 worker：结果写回固定下标，保证输出顺序 = 输入顺序 */
async function runPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

function snapshot(task, { withResults = false } = {}) {
  const pct = task.total ? Math.round((task.done / task.total) * 100) : 100;
  return {
    id: task.id,
    assignmentId: task.assignmentId,
    status: task.status,
    total: task.total,
    done: task.done,
    ok: task.ok,
    failed: task.failed,
    progress: pct,
    elapsedMs: task.finishedAt ? task.elapsedMs : Date.now() - task.startedAtMs,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    concurrency: task.concurrency,
    cancelled: task.cancelled,
    errors: task.errors.slice(0, 10),
    ...(withResults ? { results: task.results.filter(Boolean) } : {}),
  };
}

/**
 * 启动一个批量批改任务（异步执行，立即返回 taskId）
 * @param {object} o
 * @param {object} o.assignment 作业对象（含 id/title/type/description/rubric）
 * @param {Array<{studentId?:string, studentName?:string, text:string, submissionId?:string}>} o.submissions
 * @param {number} [o.concurrency]
 */
export function startBatch({ assignment, submissions, concurrency = DEFAULT_CONCURRENCY }) {
  const list = (submissions || []).filter((s) => s && typeof s.text === 'string');
  const id = `batch_${randomUUID().slice(0, 8)}`;
  const task = {
    id,
    assignmentId: assignment?.id || 'unknown',
    assignmentTitle: assignment?.title || '',
    status: list.length ? 'running' : 'idle',
    total: list.length,
    done: 0,
    ok: 0,
    failed: 0,
    results: [],
    errors: [],
    cancelled: false,
    concurrency: Math.max(1, Math.min(MAX_CONCURRENCY, Number(concurrency) || DEFAULT_CONCURRENCY)),
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    finishedAt: null,
    elapsedMs: 0,
  };
  tasks.set(id, task);

  // 不 await：调用方立刻拿到 taskId 去轮询
  (async () => {
    await runPool(list, task.concurrency, async (item, index) => {
      if (task.cancelled) return null;
      let result = null;
      let lastErr = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          result = await gradeAssignment({ assignment, studentText: item.text });
          break;
        } catch (e) {
          lastErr = e;
          if (task.cancelled) break;
        }
      }
      task.done += 1;
      if (result) {
        task.ok += 1;
        // 逐份落库：中途崩溃也不丢前面批完的成绩
        let resultId = null;
        try {
          resultId = saveGradingResult({
            submissionId: item.submissionId || `batch:${task.id}:${index}`,
            assignmentId: task.assignmentId,
            studentId: item.studentId || 'unknown',
            result,
          });
        } catch {
          /* 落库失败不推翻批改结果 */
        }
        return {
          index,
          ok: true,
          studentId: item.studentId || '',
          studentName: item.studentName || '',
          total_score: result.total_score,
          lowConfidence: (result.dimensions || []).filter((d) => d.confidence === 'low').length,
          resultId,
          attempts: result ? 1 : MAX_ATTEMPTS,
        };
      }
      task.failed += 1;
      task.errors.push({ studentId: item.studentId || '', index, error: String(lastErr?.message || lastErr || '未知错误') });
      return {
        index,
        ok: false,
        studentId: item.studentId || '',
        studentName: item.studentName || '',
        total_score: null,
        error: String(lastErr?.message || lastErr || '未知错误'),
      };
    }).then((arr) => {
      task.results = arr;
    });

    task.elapsedMs = Date.now() - task.startedAtMs;
    task.finishedAt = new Date().toISOString();
    task.status = task.cancelled ? 'cancelled' : task.failed === task.total ? 'failed' : 'done';
  })();

  return snapshot(task);
}

export function getBatch(id, opts) {
  const t = tasks.get(id);
  return t ? snapshot(t, opts) : null;
}

export function cancelBatch(id) {
  const t = tasks.get(id);
  if (!t) return null;
  t.cancelled = true;
  t.status = 'cancelled';
  return snapshot(t);
}

export function listBatches(limit = 10) {
  return [...tasks.values()].slice(-limit).reverse().map((t) => snapshot(t));
}

/** 按 id 直接取分布统计，路由层不用碰内部可变对象 */
export function batchSummaryById(id) {
  const t = tasks.get(id);
  return t ? batchSummary(t) : null;
}

/** 批量结果的分布统计，给学情看板/演示用 */
export function batchSummary(task) {
  const ok = (task.results || []).filter((r) => r && r.ok);
  const scores = ok.map((r) => r.total_score).filter((n) => typeof n === 'number');
  if (!scores.length) return { count: 0 };
  const sorted = [...scores].sort((a, b) => a - b);
  return {
    count: scores.length,
    avg: +(scores.reduce((s, x) => s + x, 0) / scores.length).toFixed(1),
    highest: sorted[sorted.length - 1],
    lowest: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    passRate: +(scores.filter((s) => s >= 60).length / scores.length).toFixed(2),
    lowConfidenceTotal: ok.reduce((s, r) => s + (r.lowConfidence || 0), 0),
    distribution: [
      { range: '0-59', count: scores.filter((s) => s < 60).length },
      { range: '60-69', count: scores.filter((s) => s >= 60 && s < 70).length },
      { range: '70-79', count: scores.filter((s) => s >= 70 && s < 80).length },
      { range: '80-89', count: scores.filter((s) => s >= 80 && s < 90).length },
      { range: '90-100', count: scores.filter((s) => s >= 90).length },
    ],
  };
}
