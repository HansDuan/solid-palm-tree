/**
 * 题型注册表（B 同学 · 多题型扩展）
 *
 * 设计目标：让「教师上传标准答案 → 程序按题型对照批改」成为通用能力。
 * 新增一种题型只需在这里加一条记录，pipeline / prompts / MOCK 全部自动支持。
 *
 * keyMode 含义：
 *   - 'exact'   客观题：标准答案里能抽出「逐题正确项」，学生答案逐项比对（选择/填空/计算最终答案）
 *   - 'solution' 主观题：标准答案是「参考解」，按要点/关键结论比对，允许等效不同做法（证明/论述/代码/作文）
 */

export const TYPES = {
  choice: {
    label: '选择题',
    keyMode: 'exact',
    rubric: [
      { name: '答案正确性', max: 60, criteria: ['每题选项与标准答案一致'], mockKeys: ['选', '答案', '正确', '选项'] },
      { name: '概念理解', max: 20, criteria: ['概念使用准确'], mockKeys: ['定义', '概念', '性质'] },
      { name: '推理过程', max: 20, criteria: ['有判定依据', '排除错误项的理由'], mockKeys: ['因为', '由于', '所以', '理由'] },
    ],
    instruction:
      '逐题列出选项，对照标准答案判对错；只对选错的题扣分，并说明正确选项及其依据。客观题只看结果与简要理由，不要求完整推导。',
  },
  fill: {
    label: '填空题',
    keyMode: 'exact',
    rubric: [
      { name: '答案正确性', max: 70, criteria: ['每空与标准答案一致'], mockKeys: ['是', '为', '答案', '结果'] },
      { name: '术语规范', max: 15, criteria: ['用词准确'], mockKeys: ['术语', '单位'] },
      { name: '书写完整', max: 15, criteria: ['无漏写关键量'], mockKeys: ['完整'] },
    ],
    instruction:
      '逐空对照标准答案的关键词/等价表述；同义、数值等价（如 1/2 与 0.5、π 与 3.14 近似）判对；单位/格式差异不影响正确性。',
  },
  calc: {
    label: '计算/解答题',
    keyMode: 'exact',
    rubric: [
      { name: '最终答案正确', max: 35, criteria: ['结果/表达式与标准答案一致'], mockKeys: ['=', '得', '结果', '答'] },
      { name: '关键步骤完整', max: 30, criteria: ['推导连贯', '公式使用正确'], mockKeys: ['解：', '因为', '所以', '代入', '由'] },
      { name: '方法正确', max: 20, criteria: ['所用方法适用'], mockKeys: ['定理', '性质', '令', '设'] },
      { name: '书写与单位', max: 15, criteria: ['书写规范', '单位正确'], mockKeys: ['单位', '注', '说明'] },
    ],
    instruction:
      '重点核对【最终答案的数值/表达式】是否与标准答案一致：一致则「最终答案正确」给满分；不一致时先检查中间步骤是否仍可给步骤分。公式需与标准答案的等价形式判定（如 a/b 与 (a/b)）。',
  },
  code: {
    label: '编程题',
    keyMode: 'solution',
    rubric: [
      { name: '正确性', max: 40, criteria: ['功能正确', '边界条件处理'], mockKeys: ['def ', 'return', 'if ', 'for ', 'while ', 'class '] },
      { name: '算法与复杂度', max: 20, criteria: ['时间复杂度合理', '无明显冗余'], mockKeys: ['复杂度', 'O(', 'log', '效率'] },
      { name: '可读性', max: 20, criteria: ['命名规范', '结构清晰'], mockKeys: ['=', '_', 'class ', 'self'] },
      { name: '注释与说明', max: 20, criteria: ['关键逻辑有注释'], mockKeys: ['#', '//', '说明', '注意'] },
    ],
    instruction:
      '以标准答案为参考解：先核对函数签名/输入输出是否符合题目要求，再判逻辑正确性；能正确处理的边界条件给满分；只要运行行为符合题目要求即给分，不要求与参考解实现一致。',
  },
  math: {
    label: '数学推导题',
    keyMode: 'solution',
    rubric: [
      { name: '关键步骤完整性', max: 30, criteria: ['步骤完整', '推导连贯'], mockKeys: ['解：', '因为', '所以', '故', '由', '即', '因此', '综上'] },
      { name: '方法正确性', max: 30, criteria: ['方法使用正确', '定理适用'], mockKeys: ['法则', '定理', '性质', '设', '令', '代入', '倒序'] },
      { name: '计算准确性', max: 20, criteria: ['结果正确', '计算无误'], mockKeys: ['=', '即', '得', '结果'] },
      { name: '书写与解释', max: 20, criteria: ['书写规范', '有文字说明'], mockKeys: ['说明', '由于', '综上', '证毕', '注意'] },
    ],
    instruction:
      '以标准答案为参考解：核对关键步骤（设元、代入公式、推导、结论）是否完整；最终结论与标准答案等价（如形式不同但数学相等）即算对。',
  },
  proof: {
    label: '证明题',
    keyMode: 'solution',
    rubric: [
      { name: '思路主线', max: 35, criteria: ['证明方向正确', '结构清晰'], mockKeys: ['证：', '欲证', '只需证', '不妨设', '归纳'] },
      { name: '定理运用', max: 30, criteria: ['所用定理正确', '条件满足'], mockKeys: ['由', '根据', '定理', '引理', '性质'] },
      { name: '推导严密', max: 20, criteria: ['每一步可推导', '无跳跃'], mockKeys: ['因为', '所以', '故', '即'] },
      { name: '书写规范', max: 15, criteria: ['符号规范', '结论明确'], mockKeys: ['证毕', '得证', '综上'] },
    ],
    instruction:
      '核对证明思路主线与所用定理是否与标准答案一致；采用不同但 valid 的证明路径也给满分；只在逻辑断裂（跳步无法补齐/反例）处扣分，并指明断裂点。',
  },
  essay: {
    label: '简答/论述题',
    keyMode: 'solution',
    rubric: [
      { name: '要点覆盖', max: 40, criteria: ['覆盖标准答案核心要点'], mockKeys: ['首先', '其次', '原因', '因为', '例如'] },
      { name: '论证质量', max: 30, criteria: ['论据充分', '逻辑自洽'], mockKeys: ['因此', '所以', '可见', '综上'] },
      { name: '结构与表达', max: 30, criteria: ['条理清晰', '表述准确'], mockKeys: ['一、', '二、', '总结', '总之'] },
    ],
    instruction:
      '以标准答案为内容要点清单：逐条核对要点覆盖度；表述不同但要点命中即给分；重点看论点、论据、结构，不苛求与参考用词完全一致。',
  },
  english: {
    label: '英语写作',
    keyMode: 'solution',
    rubric: [
      { name: '任务完成度', max: 35, criteria: ['覆盖全部写作要点'], mockKeys: ['first', 'because', 'however', 'in conclusion', 'should'] },
      { name: '语法准确', max: 30, criteria: ['时态/单复数/句式正确'], mockKeys: ['the', 'is', 'are', 'to', 'that'] },
      { name: '内容与连贯', max: 20, criteria: ['内容充实', '衔接自然'], mockKeys: ['and', 'but', 'so', 'which', 'while'] },
      { name: '词汇与结构', max: 15, criteria: ['用词得体', '句式有变化'], mockKeys: ['more', 'better', 'important', 'suggest'] },
    ],
    instruction:
      '以标准答案为内容与结构参考：核对写作要点覆盖、语法正确性、任务完成度；不苛求用词与参考完全一致，但语法硬错（时态/单复数/主谓一致）应明确扣分。',
  },
};

/** 已知题型 id 列表 */
export const TYPE_IDS = Object.keys(TYPES);

/** 取题型元信息，未知类型兜底为 math（最通用） */
export function getType(type) {
  return TYPES[type] || TYPES.math;
}

/** 从作业文本猜测题型（与 pipeline.guessType 保持一致，集中在此便于维护） */
export function guessTypeFromText(text = '') {
  const t = String(text || '');
  if (/选择|单选|多选|下列选项|\(\s*[A-D]\s*\)/.test(t)) return 'choice';
  if (/填空|请在横线|空白处填/.test(t)) return 'fill';
  if (/代码|编程|算法|函数|function|时间复杂度|实现/.test(t)) return 'code';
  if (/证明|证：|求证/.test(t)) return 'proof';
  if (/英语|作文|Essay|写一段|write an? (essay|letter|passage)/i.test(t)) return 'english';
  if (/论述|简答|谈谈|阐述|分析（?不计算）/.test(t)) return 'essay';
  if (/计算|求值|算出|解方程|计算题/.test(t)) return 'calc';
  return 'math';
}

/** 题型专属指令（注入到批改 prompt） */
export function typeInstruction(type) {
  return getType(type).instruction;
}
