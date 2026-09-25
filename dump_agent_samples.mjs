// 抓取 Agent 四工具的真实 data JSON 结构（MOCK 模式跑，仅取结构给前端联调用）
import { tool_grade_assignment, tool_get_class_report, tool_generate_warning_list, tool_generate_practice } from './lib/store/memory.js';
import { writeFileSync } from 'node:fs';

const out = {};
// 先批改落库，再看板就有 REAL 数据（展示有数据的分支）
const ga = await tool_grade_assignment({ assignmentId: 'A1' });
out['grade_assignment'] = { assignmentId: ga.assignmentId, count: ga.count, results: ga.results.slice(0, 1) };
out['get_class_report'] = await tool_get_class_report({ assignmentId: 'A1' });
out['warning_list'] = await tool_generate_warning_list({});
out['generate_practice'] = await tool_generate_practice({ assignmentId: 'A1' });
writeFileSync('C:/Users/Administrator/learnbuddy/agent_tools_sample.json', JSON.stringify(out, null, 2));
console.log('written');
console.log('report keys:', Object.keys(out.get_class_report).join(','));
console.log('warning[0]:', JSON.stringify(out.warning_list.students[0]));
console.log('grade[0] keys:', Object.keys(ga.results[0]).join(','));
