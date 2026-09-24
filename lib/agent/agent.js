/**
 * Agent 调度：意图识别 → 工具调用 → 口语化总结
 * 演示 6 条指令全部走这条链路（见 README 的演示清单）
 */
import { chat, isMock } from '../grading/llm.js';
import { AGENT_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT } from '../grading/prompts.js';
import { TOOLS } from '../store/memory.js';

export async function recognizeIntent(message) {
  const raw = await chat({ system: AGENT_SYSTEM_PROMPT, user: message, temperature: 0.1, task: 'intent', expectJson: true });
  try {
    return JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
  } catch {
    return { tool: 'none', args: {} };
  }
}

export async function runAgent(message) {
  const { tool, args = {} } = await recognizeIntent(message);
  if (!TOOLS[tool]) {
    return {
      tool: 'none',
      reply: '我目前能帮你：批改指定作业、看学情报告、列出预警名单、给薄弱学生生成练习。你想先看哪一个？',
    };
  }
  const data = await TOOLS[tool](args);
  const summary = await chat({
    system: SUMMARY_SYSTEM_PROMPT,
    user: `工具：${tool}\n数据：${JSON.stringify(trim(data)).slice(0, 3000)}`,
    temperature: 0.3,
    task: 'summary',
    expectJson: false,
  });
  return { tool, data, reply: summary };
}

/** 给模型做总结时裁剪数据量，避免上下文爆掉 */
function trim(data) {
  if (Array.isArray(data)) return data.slice(0, 10);
  if (data?.results) return { ...data, results: data.results.slice(0, 10) };
  if (data?.practices) return data;
  if (data?.students) return { ...data, students: data.students.slice(0, 10) };
  return data;
}

export function agentMode() {
  return isMock() ? 'MOCK' : 'REAL';
}
