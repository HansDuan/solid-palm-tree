/**
 * 选择题批量批改（B 同学 · 高准确率 + 零模型依赖）
 *
 * 教师一次性上传：
 *   - 标准答案键（一串选择题答案，如 "1.B 2.C 3.A 4.B" 或图片）
 *   - 一批学生答案（一行一个学生，可带姓名前缀："张三: 1.B 2.C..." 或 "001,1.B 2.C..."）
 * 程序逐题比对，产出：每人得分/逐题对错 + 班级平均/各题正确率。
 *
 * 设计要点：
 *   - 纯规则比对，不调大模型 → 秒级、100% 可复现、不受文本模型时延影响。
 *   - 复用 key.js 的 parseKey / parseStudentAnswers / compareExact（数值等价、逐题对齐）。
 */
import { parseKey, parseStudentAnswers, compareExact } from './key.js';

/**
 * 从一行学生答案里拆出「姓名/学号 + 答案串」
 * 兼容：
 *   ① 非数字姓名 + 分隔符： "张三: 1.B 2.C" / "李四，1.A 2.C" / "王五、1.C 2.D"
 *   ② 数字学号 + 分隔符：   "001,1.A 2.C" / "002、1.B 2.A"（分隔符不可为点号，避免与「1.A」混淆）
 *   ③ 纯答案（无姓名）：    "1.B 2.C 3.A"
 * 关键点：必须先把「姓名/学号前缀」剥离，再交给 parseStudentAnswers，
 * 否则 "001," 会被正则误判为 q=00 / answer=1。
 */
function splitNameAndAnswers(line) {
  const s = String(line || '').trim();
  // 情况①：非数字姓名 + 分隔符
  let m = s.match(/^([^\d]+?)\s*[:：,，、]\s*(.+)$/);
  // 校验放宽：答案串可以是题号数字，也可以是纯选项字母/√×（「张三: B C A B」这种空格分隔写法没有数字）
  if (m && /[1-9①-⑩A-Za-z√×]/.test(m[2])) return { name: m[1].trim(), answers: m[2].trim() };
  // 情况②：数字学号 + 分隔符（不含点号，避免与「1.A」混淆）
  m = s.match(/^(\d+)\s*[,，、:：]\s*(.+)$/);
  if (m && /[1-9①-⑩A-Za-z√×]/.test(m[2])) return { name: m[1].trim(), answers: m[2].trim() };
  // 情况③：纯答案
  return { name: '', answers: s };
}

/**
 * @param {{keyText:string, submissions:Array<{name?:string,text:string}>, totalPoints?:number}} arg
 */
export function gradeChoiceBatch({ keyText, submissions = [], totalPoints = 100 }) {
  const key = parseKey(keyText, 'exact').items;
  const n = Math.max(key.length, 1);
  const perQ = Math.round(totalPoints / n); // 每题分值（整除到整数）

  const results = submissions
    .map((s, i) => {
      const line = String(s.text || '').trim();
      if (!line) return null;
      const { name, answers } = splitNameAndAnswers(line);
      const ans = parseStudentAnswers(answers, 'exact');
      const cmp = compareExact(key, ans);
      return {
        name: name || s.name || `学生${i + 1}`,
        raw: line,
        score: Math.round(cmp.ratio * totalPoints),
        correct: cmp.hit,
        total: cmp.total,
        ratio: +(cmp.ratio).toFixed(2),
        perQuestion: cmp.detail.map((d) => ({
          q: d.q,
          expected: d.expected,
          got: d.got,
          ok: d.ok,
        })),
      };
    })
    .filter(Boolean);

  const count = results.length;
  const scores = results.map((r) => r.score);
  const avg = count ? Math.round(scores.reduce((a, b) => a + b, 0) / count) : 0;
  const highest = count ? Math.max(...scores) : 0;
  const lowest = count ? Math.min(...scores) : 0;
  const passRate = count ? scores.filter((s) => s >= 60).length / count : 0;

  // 各题正确率（教学洞察：哪题全班错得最多）
  const questionStats = key.map((_, i) => {
    const correctCount = results.filter((r) => r.perQuestion[i] && r.perQuestion[i].ok).length;
    return {
      q: i + 1,
      expected: key[i],
      correctRate: count ? +(correctCount / count).toFixed(2) : 0,
      wrongCount: count - correctCount,
    };
  });

  return {
    key,
    nQuestions: n,
    perQuestionPoints: perQ,
    totalPoints,
    count,
    avg,
    highest,
    lowest,
    passRate: +passRate.toFixed(2),
    results,
    questionStats,
  };
}
