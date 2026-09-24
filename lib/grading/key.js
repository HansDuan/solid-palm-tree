/**
 * 答案键感知批改（B 同学 · 多题型 + 高准确率的核心能力）
 *
 * 教师上传标准答案（answerKey）后，批改时把「标准答案」注入 prompt，
 * 让模型对照给分 —— 客观题逐项核对、主观题按参考解比对，整体准确率显著高于纯 rubric 批改。
 *
 * 双模式：REAL 走混元对照判分；MOCK 用确定性规则模拟（客观题逐项比对），保证无 Key 也能演示正确行为。
 */
import { chat, isMock, defaultRubric } from './llm.js';
import { parseWithRetry } from './parse.js';
import { KEY_GRADE_SYSTEM_PROMPT, buildKeyGradeUser } from './prompts.js';
import { getType, guessTypeFromText, typeInstruction } from './types.js';

const MAX_RETRY = 3;

/* ── 答案键解析 ── */

/** 去掉「标准答案：」「参考答案」之类的引导语 */
function stripKeyPrefix(s) {
  return String(s || '')
    .replace(/^\s*(标准答案|参考答案|答案|key)\s*[:：]?\s*/i, '')
    .trim();
}

/** 标准化：去空格/标点、转小写，便于等价比对 */
function canon(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s　,，。.、()（）\[\]【】"'`]/g, '')
    .replace(/[?？!！]/g, '');
}

/** 数值等价：两边都像数字且差值极小 → 视为相等（1/2 与 0.5 等） */
function tolerantEqual(a, b) {
  const ca = canon(a);
  const cb = canon(b);
  if (!ca || !cb) return false;
  const na = Number(ca);
  const nb = Number(cb);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && ca !== '' && cb !== '') {
    return Math.abs(na - nb) < 1e-6;
  }
  return ca === cb;
}

/**
 * 把答案文本拆成「逐题答案」数组（仅 exact 题型需要）
 * 兼容：① "1.B 2.A" ② "B,A,C" ③ "①5 ②牛顿" ④ "5 / 牛顿 / 折射"
 */
export function parseKey(text, keyMode = 'exact') {
  const raw = stripKeyPrefix(text);
  if (keyMode !== 'exact') return { mode: 'solution', items: [raw] };
  const items = [];
  const byQ = raw.matchAll(/(\d+|[①②③④⑤⑥⑦⑧⑨⑩])\s*[.、)）]?\s*([^\s,，、；;]+)/g);
  const qmap = [...byQ].map((m) => m[2]);
  if (qmap.length >= 1) {
    for (const x of qmap) items.push(x);
    return { mode: 'exact', items };
  }
  // 退而求其次：按常见分隔符拆
  const seps = raw.split(/[，,、；;/\n]+/).map((s) => s.trim()).filter(Boolean);
  return { mode: 'exact', items: seps.length ? seps : [raw] };
}

/** 从学生作答中抽逐题答案（与 parseKey 同逻辑，便于对照） */
export function parseStudentAnswers(text, keyMode = 'exact') {
  if (keyMode !== 'exact') return [String(text || '')];
  const raw = String(text || '');
  const byQ = raw.matchAll(/(\d+|[①②③④⑤⑥⑦⑧⑨⑩])\s*[.、)）]?\s*([^\s,，、；;]+)/g);
  const qmap = [...byQ].map((m) => m[2]);
  if (qmap.length >= 1) return qmap;
  // 空格分隔的纯答案序列：「B C A B」「√ × √ √」——老师从 Excel/问卷星直接粘贴时最常见，必须支持
  const toks = raw.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  if (toks.length >= 2 && toks.every((t) => /^[A-Za-z√×√对错TFtf]{1,4}$/.test(t))) return toks;
  const seps = raw.split(/[，,、；;/\n]+/).map((s) => s.trim()).filter(Boolean);
  return seps.length ? seps : [raw];
}

/** 客观题逐项比对，返回命中率 0~1 与逐题明细 */
export function compareExact(keyItems, studentItems) {
  const n = Math.max(keyItems.length, studentItems.length, 1);
  let hit = 0;
  const detail = [];
  for (let i = 0; i < n; i++) {
    const k = keyItems[i];
    const s = studentItems[i];
    const ok = k != null && s != null && tolerantEqual(k, s);
    if (ok) hit++;
    detail.push({ q: i + 1, expected: k ?? '(缺)', got: s ?? '(缺)', ok });
  }
  return { ratio: hit / n, hit, total: n, detail };
}

/* ── 主入口 ── */

/**
 * @param {{assignment:object, studentText:string}} arg
 * @returns {Promise<{total_score:number, dimensions:object[], key_match:string,
 *   match_detail:string, keyMode:string, rubric:object, mode:string, strengths:string[], improvements:string[], comment:string}>}
 */
export async function gradeWithKey({ assignment, studentText }) {
  const keyMode = getType(assignment.type).keyMode;
  const type = assignment.type || guessTypeFromText(`${assignment.title || ''}${assignment.description || ''}`);
  const rubricObj =
    assignment?.rubric?.dimensions?.length
      ? { type, dimensions: assignment.rubric.dimensions }
      : defaultRubric(type);

  if (isMock()) {
    return mockGradeWithKey({ assignment, studentText, rubricObj, type, keyMode });
  }

  const user = buildKeyGradeUser({ rubric: rubricObj, assignment, studentText });
  const system = KEY_GRADE_SYSTEM_PROMPT.replace('{TYPE_INSTRUCTION}', typeInstruction(type));
  const result = await parseWithRetry(
    async (attempt) => {
      if (attempt > 0) {
        return chat({
          system,
          user: `${user}\n\n【补充】你上一次的输出不是合法 JSON，请严格只输出 JSON，不要任何解释文字。`,
          temperature: 0.1,
          task: 'gradeKey',
        });
      }
      return chat({ system, user, temperature: 0.1, task: 'gradeKey' });
    },
    rubricObj,
    MAX_RETRY
  );
  return { ...result, keyMode, mode: 'REAL' };
}

/* ── MOCK：确定性对照批改（无 Key 时演示真实行为） ── */

function mockGradeWithKey({ assignment, studentText, rubricObj, type, keyMode }) {
  const dims = rubricObj.dimensions;
  const keyText = assignment.answerKey?.text || '';
  const student = String(studentText || '');

  let keyMatch = 'none';
  let matchDetail = '';

  if (keyMode === 'exact') {
    const k = parseKey(keyText, 'exact').items;
    const s = parseStudentAnswers(student, 'exact');
    const cmp = compareExact(k, s);
    const correctnessDim = dims.find((d) => /答案正确|最终答案|要点覆盖|任务完成/.test(d.name)) || dims[0];
    const correctMax = correctnessDim?.max || dims[0].max;
    const ratio = cmp.ratio;
    keyMatch = ratio >= 0.99 ? 'full' : ratio > 0 ? 'partial' : 'none';
    matchDetail = `客观题逐项核对：命中 ${cmp.hit}/${cmp.total}（${(ratio * 100).toFixed(0)}%）`;
    // 把「答案正确性」维度按命中率给分，其余维度用通用启发式
    const out = dims.map((d) => {
      let factor;
      if (d === correctnessDim) {
        factor = 0.4 + 0.6 * ratio;
      } else {
        factor = generalFactor(student, d);
      }
      factor += ((hashInt(student + d.name) % 11) - 5) / 100;
      factor = Math.max(0.15, Math.min(1, factor));
      const score = Math.max(0, Math.min(d.max, Math.round(d.max * factor)));
      const located = score / d.max >= 0.6;
      return {
        name: d.name,
        score,
        max: d.max,
        evidence: located ? pickEvidence(student) : '（未在原文中找到明确支撑）',
        reason: located ? '命中判定要点' : '证据不足，按常规标准给分',
        confidence: located ? 'high' : 'low',
      };
    });
    return finalize({ dims: out, keyMatch, matchDetail, rubricObj, type, keyMode });
  }

  // solution 题型：按关键词重叠判定
  const keyTerms = keyTermsOf(keyText);
  const hitTerms = keyTerms.filter((t) => student.includes(t) || canon(student).includes(canon(t)));
  const ratio = keyTerms.length ? hitTerms.length / keyTerms.length : 0.5;
  keyMatch = ratio >= 0.75 ? 'full' : ratio >= 0.4 ? 'partial' : 'none';
  matchDetail = `与参考解要点比对：覆盖 ${hitTerms.length}/${keyTerms.length} 个核心要点`;
  const out = dims.map((d) => {
    let factor = 0.35 + 0.55 * ratio;
    factor += ((hashInt(student + d.name) % 11) - 5) / 100;
    factor = Math.max(0.15, Math.min(1, factor));
    const score = Math.max(0, Math.min(d.max, Math.round(d.max * factor)));
    const located = score / d.max >= 0.6;
    return {
      name: d.name,
      score,
      max: d.max,
      evidence: located ? pickEvidence(student) : '（未在原文中找到明确支撑）',
      reason: located ? '命中参考解要点' : '证据不足，按常规标准给分',
      confidence: located ? 'high' : 'low',
    };
  });
  return finalize({ dims: out, keyMatch, matchDetail, rubricObj, type, keyMode });
}

function finalize({ dims, keyMatch, matchDetail, rubricObj, type, keyMode }) {
  const total = dims.reduce((s, d) => s + d.score, 0);
  return {
    total_score: total,
    dimensions: dims,
    key_match: keyMatch,
    match_detail: matchDetail,
    keyMode,
    rubric: rubricObj,
    mode: 'MOCK',
    strengths: dims.filter((d) => d.score / d.max >= 0.8).map((d) => `${d.name}完成质量较好`),
    improvements: dims.filter((d) => d.score / d.max < 0.7).map((d) => `${d.name}需要补充`),
    comment: `（对照标准答案的 MOCK 批改）本次作业整体完成${
      total >= 80 ? '良好' : total >= 60 ? '合格' : '偏弱'
    }，${matchDetail}；建议重点补强${
      dims.filter((d) => d.score / d.max < 0.7).map((d) => d.name).join('、') || '细节表述'
    }。`,
  };
}

/* ── 小工具 ── */

function generalFactor(text, dim) {
  const t = String(text || '');
  const keys = dim.mockKeys || [];
  const hit = keys.filter((k) => t.includes(k)).length;
  const ratio = keys.length ? hit / keys.length : 0.5;
  let f = 0.5 + 0.5 * Math.sqrt(ratio);
  if (/注释|说明/.test(dim.name) && !/#|\/\//.test(t)) f = Math.min(f, 0.3);
  if (/可读/.test(dim.name) && !/^\s{2,}\S/m.test(t) && !/解：|答案/.test(t)) f = Math.min(f, 0.55);
  if (/复杂度|算法/.test(dim.name) && !/O\(|复杂度|效率/.test(t)) f = Math.min(f, 0.45);
  if (/答案正确|计算准确|最终答案/.test(dim.name) && !/[=＝]/.test(t)) f = Math.min(f, 0.4);
  return f;
}

function pickEvidence(text) {
  const line = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)[0];
  return (line || '（已作答）').slice(0, 60);
}

function keyTermsOf(text) {
  const t = String(text || '');
  const terms = (t.match(/[\u4e00-\u9fa5]{2,5}|[A-Za-z]{3,}/g) || [])
    .map((w) => w.toLowerCase())
    .filter((w, i, a) => a.indexOf(w) === i && w.length >= 2);
  return terms.slice(0, 12);
}

function hashInt(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
