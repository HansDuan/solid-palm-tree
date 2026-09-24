/**
 * 批改 Pipeline：rubric → 证据链评分 → 解析校验重试 → 一致性保险
 * 使用方式见 README.md
 */
import { chat, defaultRubric, isMock } from './llm.js';
import { parseWithRetry } from './parse.js';
import {
  GRADE_SYSTEM_PROMPT,
  buildGradeUser,
  RUBRIC_SYSTEM_PROMPT,
  buildRubricUser,
} from './prompts.js';
import { gradeWithKey } from './key.js';
import { guessTypeFromText } from './types.js';

const MAX_RETRY = 3;

/** 判断作业是否带标准答案（教师上传过答案键） */
export function hasAnswerKey(assignment) {
  const k = assignment?.answerKey;
  const text = typeof k === 'string' ? k : k?.text;
  return Boolean(text && String(text).trim());
}

/** ① rubric：优先用作业自带的，否则生成（真实模式调模型，MOCK 模式用内置量表） */
export async function ensureRubric(assignment) {
  if (assignment?.rubric?.dimensions?.length) return assignment.rubric;
  const type = assignment?.type || guessType(assignment);
  if (isMock()) return defaultRubric(type);
  try {
    const raw = await chat({
      system: RUBRIC_SYSTEM_PROMPT,
      user: buildRubricUser({ assignment: { ...assignment, type } }),
      temperature: 0.3,
      task: 'rubric',
    });
    const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
    if (!obj?.dimensions?.length) throw new Error('空量表');
    return { type, dimensions: obj.dimensions };
  } catch {
    return defaultRubric(type); // 生成失败兜底到内置量表
  }
}

function guessType(assignment = {}) {
  return guessTypeFromText(`${assignment.title || ''}${assignment.description || ''}`);
}

/** ② 单份作业批改（核心） */
export async function gradeAssignment({ assignment, studentText }) {
  // 教师上传了标准答案 → 走答案键感知批改（对照给分，准确率更高）
  if (hasAnswerKey(assignment)) {
    const r = await gradeWithKey({ assignment, studentText });
    return { ...r, rubric: r.rubric || (await ensureRubric(assignment)), usedAnswerKey: true };
  }

  const rubric = await ensureRubric(assignment);
  const user = buildGradeUser({ rubric, assignment, studentText });
  const result = await parseWithRetry(
    async (attempt) => {
      if (attempt > 0 && !isMock()) {
        // 重试时追加「严格 JSON」提示，实测能修掉大部分半结构化输出
        return chat({
          system: GRADE_SYSTEM_PROMPT,
          user: `${user}\n\n【补充】你上一次的输出不是合法 JSON，请严格只输出 JSON，不要任何解释文字。`,
          temperature: 0.1,
          task: 'grade',
        });
      }
      return chat({ system: GRADE_SYSTEM_PROMPT, user, temperature: 0.1, task: 'grade' });
    },
    rubric,
    MAX_RETRY
  );
  return { ...result, rubric, mode: isMock() ? 'MOCK' : 'REAL', usedAnswerKey: false };
}

/** ③ 一致性检查：同一份作业连跑 n 次，返回每次结果 + 分差 */
export async function gradeWithConsistency({ assignment, studentText, times = 3 }) {
  const runs = [];
  for (let i = 0; i < times; i++) runs.push(await gradeAssignment({ assignment, studentText }));
  const scores = runs.map((r) => r.total_score);
  const spread = (Math.max(...scores) - Math.min(...scores)) / 100; // 相对满分的分差
  const median = scores.slice().sort((a, b) => a - b)[Math.floor(times / 2)];
  return { runs, scores, spread, median, reliable: spread <= 0.05 };
}

/** ④ 批量批改（含失败兜底，不中断） */
export async function gradeBatch({ assignment, submissions, concurrency = 3 }) {
  const out = [];
  const queue = [...submissions];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        const r = await gradeAssignment({ assignment, studentText: item.text });
        out.push({ ...item, ok: true, ...r });
      } catch (e) {
        out.push({ ...item, ok: false, error: String(e.message || e), total_score: null });
      }
    }
  });
  await Promise.all(workers);
  return out;
}
