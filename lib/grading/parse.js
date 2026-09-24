/**
 * JSON 解析 + 校验 + 重试（B 同学 · 批改质量加固）
 * 目标：把大模型「偶尔输出费话 / 断句 / 分数越界」的情况全部拦在 pipeline 里。
 */

export class ParseError extends Error {}

/** 从任意文本中剥出第一个合法 JSON 对象 */
export function extractJson(raw) {
  if (!raw) throw new ParseError('模型返回为空');
  let text = raw.trim();
  // 去掉 ```json ... ``` 包裹
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ParseError('未找到 JSON 结构');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new ParseError(`JSON 解析失败: ${e.message}`);
  }
}

/**
 * 按 rubric 校验批改结果
 * @param {object} obj 解析出的结果
 * @param {{dimensions:{name:string,max:number}[]}} rubric
 */
export function validateResult(obj, rubric) {
  if (typeof obj !== 'object' || obj === null) throw new ParseError('结果不是对象');
  if (!Array.isArray(obj.dimensions)) throw new ParseError('缺少 dimensions');
  for (const d of rubric.dimensions) {
    const got = obj.dimensions.find((x) => x.name === d.name);
    if (!got) throw new ParseError(`缺少维度: ${d.name}`);
    if (typeof got.score !== 'number' || Number.isNaN(got.score)) throw new ParseError(`${d.name} 分数不是数字`);
    if (got.score < 0 || got.score > d.max) throw new ParseError(`${d.name} 分数越界: ${got.score}/${d.max}`);
    if (typeof got.evidence !== 'string') throw new ParseError(`${d.name} 缺少 evidence`);
  }
  if (typeof obj.comment !== 'string' || !obj.comment.trim()) throw new ParseError('缺少 comment');
  // 答案键对照结果（存在时校验取值合法）
  if (obj.key_match !== undefined && !['full', 'partial', 'none', 'equivalent'].includes(obj.key_match)) {
    throw new ParseError(`key_match 取值非法: ${obj.key_match}`);
  }
  if (obj.match_detail !== undefined && typeof obj.match_detail !== 'string') {
    throw new ParseError('match_detail 必须是字符串');
  }
  return true;
}

/**
 * 带重试的解析（最多 max 次）
 * @param {() => Promise<string>|string} producer 每次重新生成原始输出
 */
export async function parseWithRetry(producer, rubric, max = 3) {
  let lastErr;
  for (let i = 0; i < max; i++) {
    try {
      const raw = typeof producer === 'function' ? await producer(i) : producer;
      const obj = extractJson(raw);
      validateResult(obj, rubric);
      return normalize(obj, rubric);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** 统一结构：总分以维度之和为准，补齐缺失字段 */
export function normalize(obj, rubric) {
  const dimensions = rubric.dimensions.map((d) => {
    const got = obj.dimensions.find((x) => x.name === d.name) || {};
    return {
      name: d.name,
      score: Math.round(Number(got.score) || 0),
      max: d.max,
      evidence: String(got.evidence || '（未给出证据）').replace(/\s+/g, ' ').trim().slice(0, 60),
      reason: String(got.reason || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      confidence: got.confidence === 'low' ? 'low' : 'high',
    };
  });
  return {
    total_score: dimensions.reduce((s, d) => s + d.score, 0),
    dimensions,
    key_match: obj.key_match || 'none',
    match_detail: String(obj.match_detail || ''),
    strengths: Array.isArray(obj.strengths) ? obj.strengths : [],
    improvements: Array.isArray(obj.improvements) ? obj.improvements : [],
    comment: String(obj.comment || ''),
  };
}
