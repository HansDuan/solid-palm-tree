/**
 * ClassPilot · 学情分析核心算法（纯函数版，ESM）
 *
 * 来源：C 同学交付包 `lib/analytics.js`（原 CommonJS，此处转为 ESM 并入 B 内核）。
 * 设计原则：零第三方依赖，不碰数据库；输入普通数组/对象，方便单测。
 * 路由层只负责取数，算法全在这里（对应 eval/analytics.test.mjs → 14 PASS）。
 */

// ---------- 分词：中英混合，中文按字、英文数字按词 ----------
const TOKEN_RE = /[a-zA-Z0-9]+|[\u4e00-\u9fff]/g;

function tokenize(text) {
  const m = String(text || '').match(TOKEN_RE);
  return m ? m.map((t) => t.toLowerCase()) : [];
}

// ---------- TF-IDF + 余弦相似度（查重） ----------
function buildIdf(docs) {
  const n = docs.length;
  const df = new Map();
  for (const d of docs) {
    for (const w of new Set(d)) df.set(w, (df.get(w) || 0) + 1);
  }
  const out = new Map();
  for (const [w, c] of df) out.set(w, Math.log((n + 1) / (c + 1)) + 1);
  return out;
}

function buildVector(tokens, idfMap) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  let norm = 0;
  for (const [w, c] of tf) {
    const v = c * (idfMap.get(w) || 0);
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;
  const out = new Map();
  for (const [w, c] of tf) out.set(w, (c * (idfMap.get(w) || 0)) / norm);
  return out;
}

function cosine(a, b) {
  let s = 0;
  for (const [w, v] of a) {
    const o = b.get(w);
    if (o) s += v * o;
  }
  return s;
}

/**
 * 查重：返回相似度 >= threshold 的可疑对（只出 i<j，不重复计数）
 * @param {{student:string,text:string}[]} docs
 */
export function findPlagiarismPairs(docs, threshold = 0.3) {
  const usable = docs.filter((d) => String(d.text || '').trim());
  if (usable.length < 2) return [];
  const toks = usable.map((d) => tokenize(d.text));
  const idfMap = buildIdf(toks);
  const vecs = toks.map((t) => buildVector(t, idfMap));
  const pairs = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const sim = cosine(vecs[i], vecs[j]);
      if (sim >= threshold) {
        pairs.push({
          aStudent: usable[i].student,
          bStudent: usable[j].student,
          similarity: Math.round(sim * 1000) / 1000,
        });
      }
    }
  }
  return pairs.sort((x, y) => y.similarity - x.similarity);
}

// ---------- 成绩分布 ----------
const BUCKET_ORDER = ['0-59', '60-69', '70-79', '80-89', '90-100'];

function bucketOf(pctVal) {
  if (pctVal >= 90) return '90-100';
  if (pctVal >= 80) return '80-89';
  if (pctVal >= 70) return '70-79';
  if (pctVal >= 60) return '60-69';
  return '0-59';
}

/** @param {number[]} percentages 0~100 */
export function scoreDistribution(percentages) {
  const counts = new Map(BUCKET_ORDER.map((b) => [b, 0]));
  for (const p of percentages) counts.set(bucketOf(p), (counts.get(bucketOf(p)) || 0) + 1);
  return BUCKET_ORDER.map((bucket) => ({ bucket, count: counts.get(bucket) || 0 }));
}

// ---------- 维度均值（知识点热力图） ----------
/**
 * @param {{dimensions?:{name:string,score:number,max:number}[]}[]} results 已解析的批改结果
 */
export function dimensionAverages(results) {
  const acc = new Map(); // name -> {score, max, n}
  for (const r of results) {
    const dims = (r && r.dimensions) || [];
    for (const d of dims) {
      const cur = acc.get(d.name) || { score: 0, max: 0, n: 0 };
      cur.score += Number(d.score) || 0;
      cur.max += Number(d.max) || 0;
      cur.n += 1;
      acc.set(d.name, cur);
    }
  }
  return [...acc.entries()].map(([dimension, v]) => ({
    dimension,
    avg: Math.round((v.score / v.n) * 10) / 10,
    max: Math.round((v.max / v.n) * 10) / 10,
  }));
}

// ---------- 工具 ----------
export function pct(score, max) {
  return max ? (Number(score) / Number(max)) * 100 : 0;
}

/** 从 result_json 里安全解析出 {total, max, dimensions} */
export function parseResult(resultJson) {
  let obj = null;
  try {
    obj = typeof resultJson === 'string' ? JSON.parse(resultJson) : resultJson;
  } catch {
    obj = null;
  }
  const dims = (obj && Array.isArray(obj.dimensions) ? obj.dimensions : []).map((d) => ({
    name: d && d.name ? String(d.name) : '未命名维度',
    score: Number(d && d.score) || 0,
    max: Number(d && d.max) || 0,
  }));
  const dimMax = dims.reduce((s, d) => s + d.max, 0);
  return {
    total: Number(obj && obj.total_score) || 0,
    max: dimMax || 100,
    dimensions: dims,
  };
}

// ---------- 周报 / 练习（模板兜底，无 Key 也能演示） ----------
export function buildWeeklyReportText(stats) {
  const weak = (stats.dimensionAverages || []).slice().sort(
    (a, b) => (a.max ? a.avg / a.max : 0) - (b.max ? b.avg / b.max : 0)
  )[0];
  const head = `本周《${stats.assignmentTitle || '本次作业'}》共提交 ${stats.submissionCount || 0} 份，已批改 ${stats.gradedCount || 0} 份。`;
  const tail = weak
    ? `最薄弱维度为「${weak.dimension}」（均值 ${weak.avg}/${weak.max}），建议下节课重点讲解。`
    : '';
  return head + tail;
}

export function buildExerciseText(knowledgePoint) {
  return `【${knowledgePoint}】请完成一道相关练习题，并写出解题步骤与答案。（模板占位，接入模型后自动生成）`;
}

export { bucketOf };
