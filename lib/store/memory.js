/**
 * 虚拟班级数据 + 四个 Agent 工具的本地实现（演示期无需数据库）
 * C 同学后续接真实 SQLite 时，只需替换本文件的实现，接口保持不变。
 */
import { gradeAssignment } from '../grading/pipeline.js';
import { upsertAssignment, saveGradingResult } from './repo.js';
import { getDb } from './db.js';
import {
  scoreDistribution,
  dimensionAverages,
  parseResult,
  pct,
  findPlagiarismPairs,
} from '../analytics.js';

/* ── 确定性伪随机：每次刷新数据一致，方便反复演示 ── */
function seed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const NAMES = [
  '陈家豪', '林思彤', '王梓涵', '赵一鸣', '孙悦然', '李佳诺', '周雨萱', '吴泽楷', '郑清和', '冯佩宁',
  '何瑞阳', '许知远', '邓文杰', '曹思睿', '彭嘉树', '余文航', '沈阳阳', '韩若曦', '杨嘉禾', '施家宝',
  '张沐辰', '刘锦程', '黄芷晴', '徐乐言', '高子墨', '马逸凡', '朱婉宁', '胡斯年', '郭子谦', '罗思远',
];

export const STUDENTS = NAMES.map((n, i) => ({
  id: `stu${String(i + 1).padStart(2, '0')}`,
  name: n,
  level: (seed(n) % 100) / 100, // 学习水平 0~1
}));

export const ASSIGNMENTS = [
  {
    id: 'A1',
    course: '数据结构与算法',
    title: '二分查找实现与复杂度分析',
    type: 'code',
    description: '实现二分查找函数，处理空数组等边界条件，分析时间复杂度并加关键注释',
    answerKey: {
      type: 'code',
      text: `def binary_search(arr, target):
    if not arr:
        return -1
    left, right = 0, len(arr) - 1
    while left <= right:
        mid = (left + right) // 2
        if arr[mid] == target:
            return mid
        elif arr[mid] < target:
            left = mid + 1
        else:
            right = mid - 1
    return -1
# 时间复杂度 O(log n)，空间复杂度 O(1)`,
    },
  },
  {
    id: 'A2',
    course: '数据结构与算法',
    title: '冒泡排序与优化',
    type: 'code',
    description: '实现冒泡排序，处理边界条件，说明最好/最坏时间复杂度',
  },
  {
    id: 'A3',
    course: '高等数学',
    title: '等差数列求和公式证明',
    type: 'math',
    description: '用倒序相加法证明 Sn = n(a1+an)/2，要求步骤完整并说明所用性质',
    answerKey: {
      type: 'math',
      text: `解：设 Sn = a1 + a2 + ... + an。
将其倒序写：Sn = an + a(n-1) + ... + a1。
由等差数列性质，a1 + an = a2 + a(n-1)。
两式相加得 2Sn = n(a1 + an)，因此 Sn = n(a1 + an)/2。证毕。`,
    },
  },
  {
    id: 'A4',
    course: '数据结构与算法',
    title: '时间复杂度选择题小测',
    type: 'choice',
    description: '1. 二分查找最坏时间复杂度是？ 2. 冒泡排序最坏复杂度是？ 3. 哈希查找平均复杂度？ 4. 归并排序最坏复杂度？',
    answerKey: { type: 'choice', text: '1.B 2.C 3.A 4.B' },
  },
  {
    id: 'A5',
    course: '大学物理',
    title: '自由落体填空',
    type: 'fill',
    description: '根据自由落体公式填空：初速度 0 时，t 秒下落高度 h=____；落地速度 v=____；g 取 9.8。',
    answerKey: { type: 'fill', text: '1. (1/2)gt^2  2. gt  3. 9.8' },
  },
  {
    id: 'A6',
    course: '高等数学',
    title: '一元二次方程求根',
    type: 'calc',
    description: '解方程 x^2 - 5x + 6 = 0，写出根并验证。',
    answerKey: { type: 'calc', text: '解：Δ = 25 - 24 = 1，x = (5 ± 1)/2，故 x1 = 3，x2 = 2。' },
  },
  {
    id: 'A7',
    course: '大学英语',
    title: 'My Hometown 英语写作',
    type: 'english',
    description: 'Write a short passage (about 80 words) introducing your hometown: location, climate, and one famous food.',
    answerKey: {
      type: 'english',
      text: `My hometown is a small city in the south of China. It has a warm and wet climate, with four clear seasons. The most famous food is a kind of sweet rice dumpling, which people eat during festivals. I love my hometown because it is peaceful and friendly.`,
    },
  },
];

const TEMPLATES = {
  code: {
    strong: `def solution(arr, target):
    # 边界条件：空数组直接返回 -1，避免越界
    if not arr:
        return -1
    left, right = 0, len(arr) - 1
    while left <= right:
        mid = (left + right) // 2
        if arr[mid] == target:
            return mid
        elif arr[mid] < target:
            left = mid + 1
        else:
            right = mid - 1
    return -1
# 时间复杂度 O(log n)，每次排除一半区间；空间复杂度 O(1)`,
    weak: `def f(a, t):
    for i in range(len(a)):
        if a[i] == t:
            return i
    return -1`,
  },
  math: {
    strong: `解：设 Sn = a1 + a2 + ... + an。
将其倒序写：Sn = an + a(n-1) + ... + a1。
由等差数列性质，a1 + an = a2 + a(n-1)。
两式相加得 2Sn = n(a1 + an)，因此 Sn = n(a1 + an)/2。证毕。`,
    weak: `解：Sn = n(a1+an)/2，套公式即可。`,
  },
  choice: {
    strong: `1.B（二分查找每次排除一半，最坏 log n）
2.C（冒泡最坏 O(n^2)）
3.A（哈希平均 O(1)）
4.B（归并最坏 O(n log n)）`,
    weak: `1.A（误以为线性）
2.A（混淆了最好/最坏）
3.C（把平均当成 O(n)）
4.D（归并也是 O(n^2)？）`,
  },
  fill: {
    strong: `1. h = (1/2)gt^2
2. v = gt
3. g = 9.8 m/s^2`,
    weak: `1. h = gt
2. v = (1/2)gt^2
3. g = 10`,
  },
  calc: {
    strong: `解：Δ = (-5)^2 - 4*1*6 = 25 - 24 = 1
x = (5 ± 1)/2
x1 = 3，x2 = 2
验证：3^2 - 5*3 + 6 = 0；2^2 - 5*2 + 6 = 0。`,
    weak: `解：x^2 - 5x + 6 = 0
x = 5/2
（只写了一个根，没用求根公式）`,
  },
  english: {
    strong: `My hometown is a small city in the south of China. It has a warm and wet climate, with four clear seasons. The most famous food is a kind of sweet rice dumpling, which people eat during festivals. I love my hometown because it is peaceful and friendly.`,
    weak: `my hometown is city. weather is good. food is nice. i like it.`,
  },
};

/** 生成某次作业的全班提交（强-Strong / 弱-weak 由学生水平决定） */
export function getSubmissions(assignmentId) {
  const a = ASSIGNMENTS.find((x) => x.id === assignmentId) || ASSIGNMENTS[0];
  // 没有专属模板的题型（论述/证明等）回落到数学模板，保证演示有内容
  const tpl = TEMPLATES[a.type] || TEMPLATES.math;
  return STUDENTS.map((s) => {
    // 每个人的「本次发挥」= 基础水平 + 本次作业扰动（-0.35~+0.35），保证有升有降、预警名单不为空
    const noise = ((seed(s.id + assignmentId) % 71) - 35) / 100;
    const quality = Math.max(0.05, Math.min(1, s.level + noise));
    const template = quality > 0.5 ? tpl.strong : tpl.weak;
    const lines = template.split('\n');
    const keep = Math.max(3, Math.round(lines.length * (0.55 + 0.45 * quality)));
    const text = lines.slice(0, keep).join('\n');
    // 低质量答案额外去掉注释/关键行，制造真实差距
    const finalText =
      quality < 0.35 && (a.type === 'code' || a.type === 'math')
        ? text.split('\n').filter((l) => !/#|备注|说明/.test(l)).join('\n')
        : text;
    return { studentId: s.id, name: s.name, text: finalText };
  });
}

/** 教师上传/更新某作业的标准答案（答案键） */
export function setAnswerKey(assignmentId, keyObj) {
  const a = ASSIGNMENTS.find((x) => x.id === assignmentId);
  if (!a) throw new Error(`作业不存在：${assignmentId}`);
  a.answerKey = keyObj;
  // 最好努力持久化到仓储层（失败不影响内存态批改）
  try {
    upsertAssignment(a);
  } catch {
    /* 仓储不可用时忽略 */
  }
  return a;
}

export function getAnswerKey(assignmentId) {
  return ASSIGNMENTS.find((x) => x.id === assignmentId)?.answerKey || null;
}

/* ───────────────── 工具实现（4 个） ───────────────── */

const CACHE_KEY = '__classpilot_results__';
function cache() {
  globalThis[CACHE_KEY] = globalThis[CACHE_KEY] || {};
  return globalThis[CACHE_KEY];
}

/** 并发池：避免 30 人班级串行真实批改耗时 (~30×95s)。上限 CONCURRENCY 路同时调用模型 */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      out[cur] = await fn(items[cur], cur);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function tool_grade_assignment({ assignmentId = 'A1', classId }) {
  const ck = cache();
  if (!ck[assignmentId]) {
    const submissions = getSubmissions(assignmentId);
    const assignment = ASSIGNMENTS.find((x) => x.id === assignmentId);
    const graded = await mapPool(submissions, 6, async (s) => {
      try {
        const r = await gradeAssignment({ assignment, studentText: s.text });
        return { studentId: s.studentId, name: s.name, result: r }; // fix: submissions 字段是 studentId（原 s.id 恒为 undefined，导致落库 student_id=NULL、预警名单缺 id）
      } catch (e) {
        // 单份批改失败（如模型额度 402）不应拖垮全班：记录错误，交由上层统计时剔除
        return { studentId: s.studentId, name: s.name, error: e.message || String(e) };
      }
    });
    // 落地真库（mode=REAL），供看板/查重/预警复用；先清旧 REAL 再写，避免重复行
    const db = getDb();
    for (const g of graded) {
      if (g.error) continue;
      try {
        db.run('DELETE FROM grading_results WHERE assignment_id=? AND student_id=? AND mode=?', [
          assignmentId,
          g.studentId,
          'REAL',
        ]);
      } catch { /* 忽略 */ }
      try {
        saveGradingResult({
          submissionId: 'sub_' + g.studentId,
          assignmentId,
          studentId: g.studentId,
          result: g.result,
        });
      } catch { /* 忽略 */ }
    }
    ck[assignmentId] = graded.map((g) =>
      g.error
        ? { studentId: g.studentId, name: g.name, error: g.error }
        : { studentId: g.studentId, name: g.name, ...g.result }
    );
  }
  return { assignmentId, count: ck[assignmentId].length, results: ck[assignmentId] };
}

export async function tool_get_class_report({ assignmentId = 'A1' }) {
  // C 同学真实实现：直接读真库里 mode=REAL 的批改结果，套用 analytics.js 的纯函数统计
  const db = getDb();
  const grades = db.all(
    'SELECT student_id, total_score, result_json FROM grading_results WHERE assignment_id = ? AND mode = ?',
    [assignmentId, 'REAL']
  );
  if (!grades.length) {
    // 诚实返回「尚无真实数据」，绝不把 MOCK 当 REAL 呈现（合规红线）
    return {
      assignmentId,
      realCount: 0,
      note: '尚无真实批改数据：请先运行真实批改（/api/grade/async 或 Agent「批改」意图）写入 REAL 结果',
      avg: 0,
      highest: 0,
      lowest: 0,
      distribution: scoreDistribution([]),
      dimensions: [],
      results: [],
    };
  }
  const names = new Map(db.all('SELECT id, name FROM students').map((r) => [r.id, r.name]));
  const parsed = grades.map((g) => parseResult(g.result_json));
  const results = grades.map((g, i) => ({
    studentId: g.student_id,
    name: names.get(g.student_id) || g.student_id,
    total_score: g.total_score != null ? g.total_score : parsed[i].total,
    dimensions: parsed[i].dimensions,
  }));
  const percentages = results.map((r, i) => pct(r.total_score, parsed[i].max));
  const avg = Math.round(percentages.reduce((a, b) => a + b, 0) / percentages.length);
  const distribution = scoreDistribution(percentages);
  const dimensions = dimensionAverages(parsed);
  const lowConfidence = results.filter((r) => r.dimensions.some((d) => d.confidence === 'low')).length;
  return {
    assignmentId,
    realCount: grades.length,
    avg,
    highest: Math.max(...percentages),
    lowest: Math.min(...percentages),
    distribution,
    dimensions,
    lowConfidence,
    results,
  };
}

export async function tool_generate_warning_list({ classId }) {
  const reports = [];
  for (const a of ASSIGNMENTS) reports.push({ id: a.id, ...(await tool_get_class_report({ assignmentId: a.id })) });
  const last = reports[reports.length - 1];
  const prev = reports[reports.length - 2];
  const { results: lastResults } = await tool_grade_assignment({ assignmentId: last.id });
  const { results: prevResults } = await tool_grade_assignment({ assignmentId: prev.id });
  const lastValid = lastResults.filter((r) => r.total_score != null);
  const prevById = new Map(prevResults.filter((r) => r.total_score != null).map((r) => [r.studentId, r]));
  const warnings = lastValid.map((r) => {
    const prevR = prevById.get(r.studentId);
    const prev = prevR ? prevR.total_score : r.total_score;
    const drop = prev - r.total_score;
    const level = r.total_score < 60 ? '高' : drop >= 8 ? '中' : '低';
    return { studentId: r.studentId, name: r.name, score: r.total_score, prev, drop, level };
  });
  return {
    students: warnings.filter((w) => w.level !== '低').sort((a, b) => b.drop - a.drop),
    total: warnings.filter((w) => w.level !== '低').length,
  };
}

const PRACTICE_BANK = {
  正确性: ['补全未处理边界：输入为空数组 / 单元素时的返回值', '构造 3 组测试用例，覆盖正常、边界、异常三类输入'],
  算法与复杂度: ['说明该解法的最好/最坏时间复杂度并给出推导', '将 O(n²) 解法改写成 O(n log n)，说明优化点'],
  可读性: ['重命名含糊变量（如 a、tmp），统一缩进为 4 空格', '将超过 30 行的函数拆分为两个职责单一的函数'],
  注释与说明: ['为每条关键分支补一行「为什么这样写」的注释', '在函数开头写一段 3 行的功能说明'],
  关键步骤完整性: ['补齐从已知条件到结论的中间推导步骤', '标注每一步所依据的定理或性质'],
  方法正确性: ['换一种方法重解本题，并比较两种解法的适用条件', '指出下列解法的错误：混淆必要条件与充分条件'],
  计算准确性: ['重算第 2、3 步的结果并核对符号', '用代入法验证最终答案是否满足原方程'],
  书写与解释: ['为解题过程补一段 50 字的思路说明', '用规范的数学符号重写第 2 步'],
  答案正确性: ['订正本题答案，并写出正确选项的判定依据', '总结本题易错点，列出 2 个常见误选'],
  概念理解: ['用自己的话解释「平均复杂度」与「最坏复杂度」的区别', '判断题：哈希查找一定是 O(1) 吗？说明理由'],
  推理过程: ['为每个错误选项写出一条排除理由', '把「感觉应该是对的」改写成一条可验证的推理'],
  最终答案正确: ['核对最终数值是否与标准答案一致', '重新计算并验证量纲/单位'],
  要点覆盖: ['补全遗漏的答题要点', '用一句话概括每个要点的核心'],
  任务完成度: ['检查是否覆盖全部题目要求', '补上缺失的写作要点'],
  思路主线: ['补出证明的关键过渡步骤', '写明每一步推理所依据的定义'],
  定理运用: ['指出所用定理的适用条件', '说明为什么该定理在此处成立'],
};

export async function tool_generate_practice({ studentIds = [], assignmentId = 'A1' }) {
  const { results } = await tool_grade_assignment({ assignmentId });
  const targets = (studentIds.length ? results.filter((r) => studentIds.includes(r.studentId)) : results)
    .filter((r) => r.total_score != null && Array.isArray(r.dimensions))
    .slice()
    .sort((a, b) => a.total_score - b.total_score)
    .slice(0, 5);
  return {
    assignmentId,
    practices: targets.map((r) => {
      const weakest = r.dimensions.slice().sort((a, b) => a.score / a.max - b.score / b.max)[0];
      return {
        studentId: r.studentId,
        name: r.name,
        score: r.total_score,
        weakPoint: weakest.name,
        items: PRACTICE_BANK[weakest.name] || ['复习本节基础概念并完成课后第 1、3 题'],
      };
    }),
  };
}

export const TOOLS = {
  grade_assignment: tool_grade_assignment,
  get_class_report: tool_get_class_report,
  generate_warning_list: tool_generate_warning_list,
  generate_practice: tool_generate_practice,
};

/**
 * 临时查重：对全班提交做文本相似度扫描（词袋 Jaccard）。
 * ⚠️ 这是 B 为给 A 同学联调「查重」Tab 提供的临时实现，复用种子提交；
 *    C 同学拿到真实库后应用真实相似度算法替换本函数，路径/参数保持不变。
 */
export async function tool_scan_plagiarism({ assignmentId = 'A1', threshold = 0.5 } = {}) {
  // C 同学真实实现：读真库 submissions.raw_text，套用 analytics.js 的 TF-IDF+余弦查重（无模型依赖，永远 REAL）
  const db = getDb();
  const subs = db.all('SELECT student_id, raw_text FROM submissions WHERE assignment_id = ?', [assignmentId]);
  // 同一学生可能有多份提交（重复上传），按 student_id 去重（取最后一条），避免「自己抄自己」误报
  const seen = new Map();
  for (const s of subs) seen.set(s.student_id, s);
  const deduped = [...seen.values()];
  const names = new Map(db.all('SELECT id, name FROM students').map((r) => [r.id, r.name]));
  const docs = deduped.map((s) => ({ student: names.get(s.student_id) || String(s.student_id), text: s.raw_text || '' }));
  const pairs = findPlagiarismPairs(docs, threshold);
  return {
    assignmentId,
    threshold,
    checkedCount: docs.length,
    flagged: pairs.length,
    pairs: pairs.map((p) => ({ a: p.aStudent, b: p.bStudent, similarity: p.similarity })),
  };
}

/** 教师新建作业（A 同学「作业管理」页需要）。返回新建对象；已存在同 id 则报错 */
export function addAssignment(input = {}) {
  const id = String(input.id || '').trim() || `A${ASSIGNMENTS.length + 1}`;
  if (ASSIGNMENTS.some((a) => a.id === id)) throw new Error(`作业已存在：${id}`);
  const assignment = {
    id,
    course: input.course || '未分类',
    title: input.title || '未命名作业',
    type: input.type || 'code',
    description: input.description || '',
  };
  if (input.answerKey) assignment.answerKey = input.answerKey;
  ASSIGNMENTS.push(assignment);
  try { upsertAssignment(assignment); } catch { /* 仓储不可用时忽略 */ }
  return assignment;
}

/** 供前端 Page 直接调用的家底数据 */
export function listAssignments() {
  return ASSIGNMENTS;
}
