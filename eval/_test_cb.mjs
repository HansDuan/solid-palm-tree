import { gradeChoiceBatch } from '../lib/grading/choice-batch.js';

const r = gradeChoiceBatch({
  keyText: '1.B 2.C 3.A 4.B',
  submissions: [
    { text: '张三: 1.B 2.C 3.A 4.B' },
    { text: '李四: 1.B 2.C 3.B 4.A' },
    { text: '001,1.A 2.C 3.A 4.B' },
    { text: '1.B 2.C 3.A' }, // 缺第4题
  ],
  totalPoints: 100,
});
console.log('key:', r.key, '| 每题分:', r.perQuestionPoints, '| 人数:', r.count);
console.log('班级: 平均', r.avg, '最高', r.highest, '最低', r.lowest, '及格率', r.passRate);
console.log('各题正确率:', r.questionStats.map((s) => `Q${s.q}:${Math.round(s.correctRate * 100)}%(${s.wrongCount}错)`).join(' '));
for (const x of r.results) {
  console.log(`  ${x.name}: ${x.score}分 正确${x.correct}/${x.total} | 逐题:`, x.perQuestion.map((p) => `${p.q}${p.ok ? '✓' : '✗'}`).join(' '));
}
