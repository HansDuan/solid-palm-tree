/**
 * 答案键感知批改 · 多题型回归（MOCK 模式，无需 API Key）
 *
 * 强制 MOCK：在导入 grading 模块前清空 HUNYUAN_API_KEY，
 * 这样 isMock()===true，走的确定性对照逻辑，结果稳定可断言。
 *
 * 用法：node eval/run_eval_key.mjs
 */
process.env.HUNYUAN_API_KEY = ''; // 必须在动态 import 之前

const { gradeWithKey, parseKey, parseStudentAnswers, compareExact } = await import('../lib/grading/key.js');
const { ASSIGNMENTS, getSubmissions } = await import('../lib/store/memory.js');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log('  \x1b[32m✅\x1b[0m', name, extra);
  } else {
    fail++;
    console.log('  \x1b[31m❌\x1b[0m', name, extra);
  }
}

console.log('== 1. 客观题逐项比对逻辑 ==');
{
  const key = parseKey('1.B 2.C 3.A 4.B', 'exact');
  const good = parseStudentAnswers('1.B 2.C 3.A 4.B', 'exact');
  const bad = parseStudentAnswers('1.A 2.A 3.C 4.D', 'exact');
  const cg = compareExact(key.items, good);
  const cb = compareExact(key.items, bad);
  check('客观题全对 ratio=1', cg.ratio === 1, `ratio=${cg.ratio}`);
  check('客观题全错 ratio<0.5', cb.ratio < 0.5, `ratio=${cb.ratio}`);
}

console.log('\n== 2. 各题型：强作答应优于弱作答，且维度分合法 ==');
for (const a of ASSIGNMENTS) {
  if (!a.answerKey) continue;
  const strongText = a.answerKey.text; // 强作答直接给标准答案本身
  const weakText = '（空白）这道题我不会做';
  const rStrong = await gradeWithKey({ assignment: a, studentText: strongText });
  const rWeak = await gradeWithKey({ assignment: a, studentText: weakText });
  const legal = rStrong.dimensions.every((d) => d.score >= 0 && d.score <= d.max);
  check(
    `[${a.id}/${a.type}] 强作答命中标准答案`,
    rStrong.key_match === 'full' || rStrong.key_match === 'partial',
    `match=${rStrong.key_match} score=${rStrong.total_score}`
  );
  check(
    `[${a.id}/${a.type}] 强作答分数 > 弱作答`,
    rStrong.total_score > rWeak.total_score,
    `strong=${rStrong.total_score} weak=${rWeak.total_score}`
  );
  check(`[${a.id}/${a.type}] 维度分全部合法(0~max)`, legal);
}

console.log('\n== 3. 全班生成数据可正常走答案键批改（抽查 A4 选择题）==');
{
  const a = ASSIGNMENTS.find((x) => x.id === 'A4');
  const subs = getSubmissions('A4');
  const sample = await gradeWithKey({ assignment: a, studentText: subs[0].text });
  check('A4 抽样批改产出 key_match', typeof sample.key_match === 'string', `match=${sample.key_match}`);
  check('A4 抽样批改产出 total_score 数值', Number.isFinite(sample.total_score), `score=${sample.total_score}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
