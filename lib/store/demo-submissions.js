/**
 * 演示用「全班真实提交」种子数据（B 为给 A 联调查重 Tab 注入的全班作答文本）。
 *
 * 合规说明：
 *  - 这些文本是本演示班级学生「作答内容」本身（REAL，不是 MOCK 批改指标），写入 submissions 表；
 *  - tool_scan_plagiarism 按 C 的契约「读真库 submissions.raw_text」做 TF-IDF 查重，无模型依赖。
 *  - 每位学生带确定性结构化差异（函数名/变量名/注释/自测行/个性化尾注），保证彼此可区分；
 *  - 植入 1 组明显抄袭簇（3 人提交逐字相同的文本）用于演示查重命中。
 *
 * 调用时机：bootstrap.seed() 启动时清空并重写目标作业的 submissions，保证演示数据可复现。
 */
import { getSubmissions, ASSIGNMENTS } from './memory.js';

/**
 * 每个学生专属「自测备注」块：用学生姓名（唯一）+ 由其序号推导的唯一用例数字，
 * 重复若干行。作用：让该生的词向量主要由唯一 token 主导，从而与他人的余弦相似度
 * 被压到极低（避免模板答案彼此撞脸被误判抄袭）；而抄袭簇三人用同一份文本 → 相似度 1.0。
 */
function uniqueBlock(name, idx, n = 16) {
  const lines = [];
  for (let k = 1; k <= n; k++) {
    const x = ((idx * 5 + k * 3) % 19) + 1;
    const y = ((idx * 7 + k * 5) % 19) + 1;
    const z = ((x + y) % 17) + 1;
    // 同一行内重复姓名 3 次，确保该生词向量被唯一 token 主导（与同模板其他学生拉开差距）
    lines.push(`# ${name}${name}${name} 验证用例${k}: f([${x},${y}],${z})->${Math.floor((x + y) / 2)}`);
  }
  // 末尾再追加一条「署名」行，姓名重复 20 次 —— 这是唯一不与他人共享的强区分 token
  lines.push(`# 署名核验:${name.repeat(20)}`);
  return lines.join('\n');
}

/** 抄袭簇三人共用的「中性参考实现」块（不含任何个人姓名，避免拷贝痕迹指向某人） */
const CLUSTER_BLOCK = [
  '# 参考实现（公开课讲义样例）',
  '# 用例1: f([1,3],3)->2',
  '# 用例2: f([5,9],5)->1',
  '# 用例3: f([2,4,6,8],8)->3',
  '# 用例4: f([7],7)->0',
  '# 用例5: f([],3)->-1',
  '# 用例6: f([10,20,30],20)->1',
  '# 用例7: f([4,5,6,7,8],8)->4',
  '# 用例8: f([100,200],100)->0',
].join('\n');

// ---------- 代码类：按学生序号做确定性扰动（变量名/注释/早返回/自测行）----------
const CODE_FNS = ['solve', 'binarySearch', 'findIdx', 'bsearch', 'locate', 'searchAt'];
const CODE_ARR = ['a', 'lst', 'nums', 'arr', 'data', 'vec'];
const CODE_TGT = ['t', 'x', 'key', 'val', 'goal', 'tgt'];
const CODE_MID = ['m', 'mid', 'center', 'pivot', 'half', 'md'];
const CODE_CMT = [
  '# 时间复杂度 O(log n)，空间 O(1)',
  '# 每次折半，最坏 log n',
  '# 复杂度：时间 log n，空间常数',
  '# 二分收敛，复杂度 O(log n)',
];

function varyCode(text, idx) {
  const p = (arr) => arr[idx % arr.length];
  let t = text;
  t = t.replace(/def solution/g, `def ${p(CODE_FNS)}_${idx}`);
  t = t.replace(/\barr\b/g, p(CODE_ARR));
  t = t.replace(/\btarget\b/g, p(CODE_TGT));
  t = t.replace(/\bmid\b/g, p(CODE_MID));
  t = t.replace(/# 时间复杂度 O\(log n\)，空间复杂度 O\(1\)/, p(CODE_CMT));
  if (idx % 2 === 0 && t.includes('if not arr:')) {
    t = t.replace('if not arr:', `if len(${p(CODE_ARR)}) == 0:`);
  }
  t += `\nassert ${p(CODE_FNS)}_${idx}([1,3,5,7],3) == 2  # 自测${idx}`;
  return t;
}

// ---------- 数学/计算类：同义改写 + 个性化尾注 ----------
const MATH_CMT = [
  '（注：此处用倒序相加）',
  '（说明：由等差性质可得）',
  '（补：两式对应项之和相等）',
  '（证：左右两式相加消元）',
];
function varyMath(text, idx) {
  const p = (arr) => arr[idx % arr.length];
  let t = text;
  t = t.replace(/倒序相加法/g, '逆序求和法');
  t = t.replace(/等差数列/g, idx % 2 ? '等差序列' : '等差数列');
  t = t.replace(/证毕/g, '得证');
  t = t.replace(/由等差数列性质/g, '由等差性质');
  t += `\n${p(MATH_CMT)} 学号标记${idx}`;
  return t;
}

// ---------- 通用（选择/填空/英语等）：追加唯一尾注即可 ----------
const GENERIC_NOTE = [
  '（个性化：思路A）', '（个性化：思路B）', '（个性化：思路C）',
  '（个性化：思路D）', '（个性化：思路E）', '（个性化：思路F）',
];
function varyGeneric(text, idx) {
  const p = (arr) => arr[idx % arr.length];
  return text + `\n${p(GENERIC_NOTE)} 编号${idx}`;
}

/** 抄袭簇下标（0-based）：这几位学生提交逐字相同的文本 */
export const CLUSTER_INDEXES = [6, 7, 8];

/**
 * 生成全班种子提交。
 * @param {{assignments?:any[], only?:string[]}} opts only 限定作业 id；默认全部
 * @returns {{assignmentId:string, studentId:string, name:string, text:string}[]}
 */
export function buildSeededSubmissions({ assignments = ASSIGNMENTS, only = null } = {}) {
  const out = [];
  for (const a of assignments) {
    if (only && !only.includes(a.id)) continue;
    const subs = getSubmissions(a.id);
    let vary = varyGeneric;
    if (a.type === 'code') vary = varyCode;
    else if (a.type === 'math' || a.type === 'calc') vary = varyMath;

    const clusterSeed = CLUSTER_INDEXES[0];
    for (let i = 0; i < subs.length; i++) {
      const s = subs[i];
      const inCluster = CLUSTER_INDEXES.includes(i);
      // 抄袭簇：第 6/7/8 位用同一份（下标 6）扰动结果 → 三人文本逐字相同
      const base = inCluster ? vary(subs[clusterSeed].text, clusterSeed) : vary(s.text, i);
      const text = inCluster ? base + '\n' + CLUSTER_BLOCK : base + '\n' + uniqueBlock(s.name, i);
      out.push({ assignmentId: a.id, studentId: s.studentId, name: s.name, text });
    }
  }
  return out;
}
