/**
 * 演示指令自检：node eval/smoke_tools.mjs
 * 对着规划书「演示只演示这 6 条」逐条验证，输出 PASS/FAIL + 耗时。
 * D6 之前必须全部 PASS。
 */
import { runAgent } from '../lib/agent/agent.js';
import { gradeAssignment } from '../lib/grading/pipeline.js';
import { listAssignments, getSubmissions } from '../lib/store/memory.js';

const COMMANDS = [
  { cmd: '批改这次提交的作业', expect: 'grade_assignment' },
  { cmd: '生成这次作业的学情分析', expect: 'get_class_report' },
  { cmd: '谁这周状态下滑？列个预警名单', expect: 'generate_warning_list' },
  { cmd: '给分数最低的 5 个学生生成个性化练习', expect: 'generate_practice' },
  { cmd: '你好，你是谁', expect: 'none' },
];

let pass = 0;
console.log('\n=== 演示指令自检 ===\n');
for (const c of COMMANDS) {
  const t0 = Date.now();
  const out = await runAgent(c.cmd);
  const ok = out.tool === c.expect;
  if (ok) pass++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${c.cmd.padEnd(22, ' ')} → tool=${out.tool}  ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );
  console.log(`      ${String(out.reply).slice(0, 90)}…`);
}

console.log('\n=== 单份批改计时（模拟 Season demo） ===\n');
const assignment = listAssignments()[0];
const sample = getSubmissions(assignment.id)[0];
const t1 = Date.now();
const r = await gradeAssignment({ assignment, studentText: sample.text });
console.log(`${sample.name} 得分 ${r.total_score}，耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s，模式 ${r.mode}`);
console.log(`证据示例：${r.dimensions[0].name} → ${r.dimensions[0].evidence}`);

console.log(`\n结果：${pass}/${COMMANDS.length} 条演示指令通过\n`);
