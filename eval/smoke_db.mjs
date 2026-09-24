/**
 * C 同学链路自检：node eval/smoke_db.mjs
 * 覆盖：数据初始化 → 文件解析(.txt/.docx) → 上传落库 → 批改结果入库 → 教师复核写回
 */
import { seed } from '../lib/store/bootstrap.js';
import { storageMode } from '../lib/store/db.js';
import { parseFile } from '../lib/parse/file.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveSubmission, saveGradingResult, listResults, saveTeacherFeedback, listFeedback } from '../lib/store/repo.js';
import { gradeAssignment } from '../lib/grading/pipeline.js';
import { listAssignments } from '../lib/store/memory.js';
import { extractSubmissionText } from '../lib/parse/extract.js';
import { extractFromFiles } from '../lib/parse/multi.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, total = 0;
const check = (name, ok, extra = '') => {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

console.log(`\n=== C 同学链路自检（存储模式：${storageMode()}） ===\n`);

const s = seed();
check('数据初始化（作业 + 学生写库）', s.assignments === 3 && s.students === 30, `作业 ${s.assignments} / 学生 ${s.students}`);

/* 1. 文件解析 */
const txtBuf = Buffer.from('def f(x):\n    return x + 1\n# 时间复杂度 O(1)', 'utf8');
const txt = await parseFile(txtBuf, 'demo.py');
check('.py/txt 解析', txt.type === 'text' && txt.text.includes('return'), `${txt.text.length} 字`);

let docxOk = false, docxNote = '';
try {
  const docxBuf = readFileSync(resolve(root, 'eval/testset/demo.docx'));
  const d = await parseFile(docxBuf, 'demo.docx');
  docxOk = d.text.includes('倒序') && d.text.includes('n(a1+an)');
  docxNote = d.text.slice(0, 24).replace(/\n/g, ' / ');
} catch (e) {
  docxNote = e.message;
}
check('.docx 解析（零依赖）', docxOk, docxNote);

/* 2. 上传 → 落库 → 批改 → 结果入库 */
const assignment = listAssignments()[0];
const sub = saveSubmission({ assignmentId: assignment.id, studentId: 'stu01', studentName: '陈家豪', text: txt.text, filename: 'demo.py', source: 'file' });
check('提交记录入库', Boolean(sub.id), sub.id);

const result = await gradeAssignment({ assignment, studentText: txt.text });
const rid = saveGradingResult({ submissionId: sub.id, assignmentId: assignment.id, studentId: 'stu01', result });
check('批改结果入库', Boolean(rid), `${rid}  总分 ${result.total_score}`);

const rows = listResults(assignment.id);
check('按作业查询成绩', rows.length >= 1 && rows[0].total_score === result.total_score, `${rows.length} 条`);

/* 2.5 多模态：拍照上传 → 转录 → 批改 → 入库 */
try {
  const imgBuf = readFileSync(resolve(root, 'eval/testset/demo-homework.png'));
  const ex = await extractSubmissionText(imgBuf, 'demo-homework.png');
  const a3 = listAssignments()[2];
  const isub = saveSubmission({
    assignmentId: a3.id,
    studentId: 'stu07',
    studentName: '周雨萱',
    text: ex.text,
    filename: 'demo-homework.png',
    source: ex.source,
  });
  const ires = await gradeAssignment({ assignment: a3, studentText: ex.text });
  saveGradingResult({ submissionId: isub.id, assignmentId: a3.id, studentId: 'stu07', result: ires });
  check(
    '拍照上传 → 转录 → 批改 → 入库',
    ex.source === 'image' && ex.text.length > 0 && ires.total_score > 0,
    `转录 ${ex.text.length} 字 → ${ires.total_score} 分${ex.mock ? '（MOCK 识别）' : '（混元 vision）'}`
  );
} catch (e) {
  check('拍照上传 → 转录 → 批改 → 入库', false, e.message);
}

/* 2.6 多页作业：两张照片合并成一份完整答案再批改 */
try {
  const p1 = readFileSync(resolve(root, 'eval/ocr-synth/m1-page1.jpg'));
  const p2 = readFileSync(resolve(root, 'eval/ocr-synth/m1-page2.jpg'));
  const merged = await extractFromFiles([
    { buffer: p1, filename: 'm1-page1.jpg' },
    { buffer: p2, filename: 'm1-page2.jpg' },
  ]);
  const bothPages = merged.pages.length === 2 && merged.pages.every((pg) => (pg.text || '').length > 10);
  // MOCK 模式每页输出带页码头，真实模式看题目内容跨页；两种模式都要求「先第 1 页后第 2 页」
  const markerA = merged.mock ? '第 1/2 页' : '第 3 题';
  const markerB = merged.mock ? '第 2/2 页' : '① - ②';
  const inOrder = merged.text.indexOf(markerA) >= 0 && merged.text.indexOf(markerA) < merged.text.indexOf(markerB);
  const a3 = listAssignments()[2];
  const msub = saveSubmission({
    assignmentId: a3.id,
    studentId: 'stu11',
    studentName: '林一鸣',
    text: merged.text,
    filename: 'm1-page1.jpg + m1-page2.jpg',
    source: merged.source,
    pageCount: 2,
  });
  const mres = await gradeAssignment({ assignment: a3, studentText: merged.text });
  saveGradingResult({ submissionId: msub.id, assignmentId: a3.id, studentId: 'stu11', result: mres });
  check(
    '多页合并（2 张照片 → 1 份答案 → 批改入库）',
    bothPages && inOrder && mres.total_score > 0,
    `合并 ${merged.text.length} 字 · 页序${inOrder ? '正确' : '错乱'} → ${mres.total_score} 分${merged.mock ? '（MOCK）' : ''}`
  );
} catch (e) {
  check('多页合并（2 张照片 → 1 份答案 → 批改入库）', false, e.message);
}

/* 2.7 稳定性护栏：超大文件必须被前置拦截，而不是把进程打挂 */
try {
  const big = Buffer.alloc(13 * 1024 * 1024, 1);
  await extractSubmissionText(big, 'too-big.jpg');
  check('OOM 护栏（>12MB 图片前置拦截）', false, '竟然没有拦截');
} catch (e) {
  check('OOM 护栏（>12MB 图片前置拦截）', /超过上限/.test(e.message), e.message.slice(0, 40));
}

/* 3. 人机协同：教师改分写回 */
const dim = result.dimensions[0];
const fbId = saveTeacherFeedback({ submissionId: sub.id, dimension: dim.name, teacherScore: dim.max, comment: '教师判定该项应给满分' });
const fbs = listFeedback(sub.id);
check('教师复核记录（人机协同闭环）', Boolean(fbId) && fbs.length === 1, `${dim.name}: AI ${dim.score} → 教师 ${fbs[0]?.teacher_score}`);

console.log(`\n结果：${pass}/${total} 通过\n`);
