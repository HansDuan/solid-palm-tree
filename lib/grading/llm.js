/**
 * 模型调用封装 —— 双模式（ LearnBuddy 项目组 · B 同学 ）
 *
 * 合规说明：本项目只允许使用腾讯混元系列模型。
 *   - 有 HUNYUAN_API_KEY   → 真实调用混元文本/多模态模型
 *   - 无 HUNYUAN_API_KEY   → MOCK 兜底（规则模拟），零成本跑通全链路，方便前端/联调今天就能演示
 *
 * MOCK 模式不影响任何真实指标调查：一旦 Key 到位，同一套 pipeline 直接切换真实链路，
 * 效果指标（一致性/MAE/解析成功率）请以真实模式跑出的 eval 报告为准。
 *
 * 稳定性（2026-09-22 补）：超时中断 / 退避重试 / 堆内存预检 / 错误翻译。
 */
import { guardHeap } from '../util/mem.js';
import { TYPES } from './types.js';

// ⚠️ 网关说明：默认走 TokenHub（`tencentmaas.com` + `x-api-key` 头，模型 hy3 / hy-vision-2.0-instruct）。
// 若 .env.local 把 HUNYUAN_BASE_URL 指向腾讯云官方混元 OpenAI 兼容端点
// （`api.hunyuan.cloud.tencent.com/v1`，鉴权头自动切为 `Authorization: Bearer`），
// 模型名改用官方系（hunyuan-standard / hunyuan-turbo / hunyuan-vision 等），仍属「仅腾讯混元」合规范围。
const BASE_URL = process.env.HUNYUAN_BASE_URL || 'https://tokenhub.tencentmaas.com/v1';
// ⚠️ 默认文本模型用 hy3 而非 hy4-preview：实测 hy4-preview 是推理模型，批改类请求会把全部 token 预算
// 消耗在 reasoning_content 上，complex prompt 下永远不输出 content（finish=length、content 为空、表现为 120s 超时）。
// hy3（同为腾讯混元，合规）推理量更小，max_tokens 给足后能在 ~40-60s 稳定产出合法 JSON。可用环境变量 HUNYUAN_TEXT_MODEL 覆盖。
const TEXT_MODEL = process.env.HUNYUAN_TEXT_MODEL || 'hy3';
const VISION_MODEL = process.env.HUNYUAN_VISION_MODEL || 'hy-vision-2.0-instruct';
const IMAGE_MODEL = process.env.HUNYUAN_IMAGE_MODEL || VISION_MODEL;

/* ── 稳定性配置（演示现场断网/限流/慢图也不至于翻车） ── */
const TEXT_TIMEOUT_MS = Number(process.env.HUNYUAN_TIMEOUT_MS || 60_000);
const VISION_TIMEOUT_MS = Number(process.env.HUNYUAN_VISION_TIMEOUT_MS || 120_000);
const NET_MAX_RETRY = Number(process.env.HUNYUAN_MAX_RETRY ?? 2);
const RETRY_BASE_MS = Number(process.env.HUNYUAN_RETRY_BASE_MS || 800);
// ⚠️ 关键：hy4-preview / hy3 在开启 response_format=json_object 且「不设 max_tokens」时会挂起（网关等待无止境生成），
// 导致 120s 超时。设上限后 10~15s 即返回。默认值足够覆盖我们的 JSON 批改输出（evidence≤60字/维度）。
const TEXT_MAX_TOKENS = Number(process.env.HUNYUAN_TEXT_MAX_TOKENS || 6144);
const VISION_MAX_TOKENS = Number(process.env.HUNYUAN_VISION_MAX_TOKENS || 2048);

export function isMock() {
  return !process.env.HUNYUAN_API_KEY;
}

export function currentMode() {
  return isMock() ? 'MOCK' : `REAL(${TEXT_MODEL} / ${IMAGE_MODEL})`;
}

export function runtimeConfig() {
  return {
    baseUrl: BASE_URL,
    textModel: TEXT_MODEL,
    imageModel: IMAGE_MODEL,
    textTimeoutMs: TEXT_TIMEOUT_MS,
    visionTimeoutMs: VISION_TIMEOUT_MS,
    maxRetry: NET_MAX_RETRY,
    mode: currentMode(),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 把底层错误翻译成教师/开发者看得懂、且能照着做的话 */
function translateError(err, label, timeoutMs) {
  const raw = err?.message || String(err);
  if (err?.name === 'AbortError' || /abort/i.test(raw)) {
    return new Error(
      `${label}超时（>${Math.round(timeoutMs / 1000)}s）。现场处理：① 换成单张已压缩的照片重试；② 或调大 .env.local 中的 HUNYUAN_VISION_TIMEOUT_MS`
    );
  }
  if (err?.status === 401 || err?.status === 403) {
    return new Error('混元 API Key 无效/无权限（' + err.status + '）。检查 .env.local 的 HUNYUAN_API_KEY，确认该 Key 已开通视觉模型额度');
  }
  if (err?.status === 429) {
    return new Error('混元接口限流（429），自动重试已达上限。批量批改时建议把并发降到 2，或在 .env.local 调大 HUNYUAN_MAX_RETRY');
  }
  if (err?.status >= 500) {
    return new Error(`混元服务端异常 ${err.status}，已重试 ${NET_MAX_RETRY} 次仍失败。这是平台侧波动，稍等 30 秒再试即可`);
  }
  if (/fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|ENOTFOUND/i.test(raw)) {
    return new Error(`网络不通，${label}失败：${raw.slice(0, 80)}。请检查本机网络/代理是否能访问 ${BASE_URL}`);
  }
  return new Error(`${label}失败：${raw.slice(0, 200)}`);
}

/**
 * 统一 HTTP 出口：超时中断 + 退避重试 + 堆内存预检 + 错误翻译
 * 任何一处出问题都要给出「下一步该做什么」，而不是甩一个 fetch failed 给老师
 */
async function requestJson({ label, body, timeoutMs }) {
  const apiKey = process.env.HUNYUAN_API_KEY;
  if (!apiKey) {
    throw new Error('缺少 HUNYUAN_API_KEY：把 .env.example 复制为 .env.local 并填入 Key（或执行 npm run key -- <你的Key>）');
  }
  const payload = JSON.stringify(body);
  guardHeap(Buffer.byteLength(payload), label);

  let lastErr = null;
  for (let attempt = 0; attempt <= NET_MAX_RETRY; attempt++) {
    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json' };
      // TokenHub 网关用 x-api-key；腾讯云官方混元 OpenAI 兼容端点用 Authorization: Bearer
      if (/hunyuan\.cloud\.tencent\.com|tencentcloudapi\.com/.test(BASE_URL)) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      } else {
        headers['x-api-key'] = apiKey;
      }
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers,
        body: payload,
        signal: ac.signal,
      });
      if (res.ok) return await res.json();
      const text = await res.text().catch(() => '');
      const e = new Error(`${label}失败 ${res.status}: ${text.slice(0, 300)}`);
      e.status = res.status;
      throw e;
    } catch (e) {
      lastErr = e;
      const retryable =
        e.name === 'AbortError' ||
        e.status >= 500 ||
        e.status === 429 ||
        /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(String(e.message));
      if (!retryable || attempt === NET_MAX_RETRY) {
        clearTimeout(timer);
        throw translateError(e, label, timeoutMs);
      }
      const waited = Math.min(8000, RETRY_BASE_MS * 2 ** attempt);
      process.stderr.write(
        `[classpilot] ${label} 第 ${attempt + 1} 次失败(${Date.now() - started}ms)，${waited}ms 后退避重试…\n`
      );
      await sleep(waited);
    } finally {
      clearTimeout(timer);
    }
  }
  throw translateError(lastErr, label, timeoutMs);
}

/** 统一入口：task 只用于 MOCK 分发与日志，不影响真实调用 */
export async function chat({ system, user, temperature = 0.1, task = 'generic', expectJson = true }) {
  if (isMock()) return mockChat({ system, user, task });
  const data = await requestJson({
    label: '混元文本调用',
    timeoutMs: TEXT_TIMEOUT_MS,
    body: {
      model: TEXT_MODEL,
      temperature,
      max_tokens: TEXT_MAX_TOKENS,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      ...(expectJson ? { response_format: { type: 'json_object' } } : {}),
    },
  });
  return data?.choices?.[0]?.message?.content || '';
}

/** 多模态：图片 base64 → 转录文本。prompt 为空时用默认手写转录 prompt */
export async function vision({ prompt, imageBase64, mimeType = 'image/jpeg', timeoutMs }) {
  if (isMock()) return mockTranscribe(prompt);
  const data = await requestJson({
    label: '混元图片识别',
    timeoutMs: timeoutMs || VISION_TIMEOUT_MS,
    body: {
      model: IMAGE_MODEL,
      temperature: 0.1,
      max_tokens: VISION_MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ],
        },
      ],
    },
  });
  return data?.choices?.[0]?.message?.content || '';
}

/* ───────────────────────── MOCK 兜底区（无 Key 时启用） ───────────────────────── */

function mockTranscribe(prompt = '') {
  // MOCK 也要尊重分页上下文：多页合并测试依赖「每页输出可区分」
  const m = String(prompt).match(/第 (\d+) 页 \/ 共 (\d+) 页/);
  const head = m ? `（MOCK 转录 · 第 ${m[1]}/${m[2]} 页）` : '（MOCK 转录结果，仅用于联调）';
  return [
    head,
    '第 1 题：证明等差数列前 n 项和 Sn = n(a1+an)/2。',
    '解：由 Sn = a1 + a2 + ... + an，倒序相加得 2Sn = (a1+an) + (a2+a(n-1)) + ... ',
    '其中每一组的和都等于 a1+an，共 n 组，故 2Sn = n(a1+an)，即 Sn = n(a1+an)/2。',
    '第 2 题：时间复杂度分析：两层循环遍历数组，时间复杂度 O(n^2)。',
  ].join('\n');
}

function mockChat({ user, task }) {
  switch (task) {
    case 'rubric': {
      const type = /代码|编程|算法/.test(user) ? 'code' : /选择/.test(user) ? 'choice' : 'math';
      return JSON.stringify({ dimensions: defaultRubric(type).dimensions });
    }
    case 'grade':
      return mockGrade(user);
    case 'intent':
      return mockIntent(user);
    case 'summary':
      return mockSummary(user);
    default:
      return '{}';
  }
}

/** 从批改 prompt 里还原 rubric 与学生原文，做规则化打分 */
function mockGrade(user) {
  const rubricMatch = user.match(/【评分维度与分值】[\s\S]*?(\{[\s\S]*?\})\s*\n/);
  const textMatch = user.match(/【学生作业原文】([\s\S]*)$/);
  const rubric = rubricMatch ? safeParse(rubricMatch[1]) : null;
  const studentText = textMatch ? textMatch[1].trim() : '';
  const dims = rubric?.dimensions || defaultRubric('code').dimensions;

  const lines = studentText.split('\n').map((l) => l.trim()).filter(Boolean);
  const hasIndent = lines.some((l) => /^\s{2,}\S/.test(l));
  const hasComment = /#|\/\//.test(studentText);
  const hasResult = /return|=|即|故|因此|所以/.test(studentText);

  const dimensions = dims.map((d) => {
    const keys = d.mockKeys || [];
    const hitKeys = keys.filter((k) => studentText.includes(k));
    const ratio = keys.length ? hitKeys.length / keys.length : 0.5;
    // 开方缩放：命中 1/4 也有 ~0.75 的基础表现，避免整体压得过低（贴合真实课堂分数分布）
    let factor = 0.5 + 0.5 * Math.sqrt(ratio);

    // 硬规则：明显缺失时压低
    if (/注释|说明/.test(d.name) && !hasComment) factor = Math.min(factor, 0.3);
    if (/可读/.test(d.name) && !hasIndent && !/解：|答案/.test(studentText)) factor = Math.min(factor, 0.55);
    if (/复杂度|算法/.test(d.name) && !/O\(|复杂度|效率/.test(studentText)) factor = Math.min(factor, 0.45);
    if (/答案正确|计算准确/.test(d.name) && !hasResult) factor = Math.min(factor, 0.4);
    if (lines.length <= 2) factor = Math.min(factor, 0.7);

    // 确定性抖动：同一份作业永远同分（保证一致性），不同作业之间有区分度
    factor += ((hashInt(studentText + d.name) % 15) - 7) / 100;
    factor = Math.max(0.15, Math.min(1, factor));

    const score = Math.max(0, Math.min(d.max, Math.round(d.max * factor)));
    const evidenceLine = lines.find((l) => hitKeys.some((k) => l.includes(k)));
    // located 只认「真正命中考点的行」。原来退化成「随便找一行」，
    // 导致 MOCK 模式永远 confidence:high，前端那个「待复核」角标一次都不亮——
    // 而它恰恰是我们人机协同叙事的视觉落点。
    const located = Boolean(evidenceLine);
    return {
      name: d.name,
      score,
      max: d.max,
      evidence: located ? evidenceLine.slice(0, 60) : '（未在原文中找到明确支撑）',
      reason: located ? `命中要点「${hitKeys[0] || keys[0] || d.name}」` : '证据不足，按常规标准给分',
      confidence: located ? 'high' : 'low',
    };
  });

  const total = dimensions.reduce((s, d) => s + d.score, 0);
  return JSON.stringify({
    total_score: total,
    dimensions,
    strengths: dimensions.filter((d) => d.score / d.max >= 0.8).map((d) => `${d.name}完成质量较好`),
    improvements: dimensions.filter((d) => d.score / d.max < 0.7).map((d) => `${d.name}需要补充`),
    comment: `本次作业整体完成${total >= 80 ? '良好' : '合格'}，亮点在于关键步骤有体现；建议重点补强${
      dimensions.filter((d) => d.score / d.max < 0.7).map((d) => d.name).join('、') || '细节表述'
    }。`,
  });
}

function mockIntent(user) {
  const table = [
    [/预警|下滑|掉队|关注名单|状态/, 'generate_warning_list'],
    [/练习|作业推荐|个性化|补习/, 'generate_practice'],
    [/学情|报告|画像|知识点|分析/, 'get_class_report'],
    [/批改|打分|评分|阅卷/, 'grade_assignment'],
  ];
  for (const [re, name] of table) if (re.test(user)) return JSON.stringify({ tool: name, args: {} });
  return JSON.stringify({ tool: 'none', args: {} });
}

/** 无 Key 时的口语化总结：从「工具：xxx / 数据：json」里取真数据，保证演示不露怯 */
function mockSummary(user) {
  const tool = (user.match(/工具：(\S+)/) || [])[1] || 'none';
  const jsonStr = (user.match(/数据：([\s\S]*)$/) || [])[1] || '{}';
  let data = null;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    data = null;
  }
  switch (tool) {
    case 'grade_assignment':
      return `已批改 ${data?.count ?? 30} 份作业。班级整体作答集中在中档区间，建议重点复核标记「待复核」的维度后再发布成绩。`;
    case 'get_class_report': {
      const weakest = data?.dimensions?.[0];
      return `本次作业平均分 ${data?.avg ?? '-'}，最高 ${data?.highest ?? '-'}，最低 ${data?.lowest ?? '-'}。最薄弱的维度是「${
        weakest?.name ?? '-'
      }」（得分率 ${weakest ? Math.round(weakest.rate * 100) : '-'}%），建议下节课先用 10 分钟针对性讲评。`;
    }
    case 'generate_warning_list': {
      const top = data?.students?.[0];
      return `共 ${data?.total ?? 0} 人需要关注，其中 ${top?.name ?? '-'} 本次 ${top?.score ?? '-'} 分，较上次下降 ${
        top?.drop ?? '-'
      } 分。建议先安排一次 15 分钟的一对一答疑。`;
    }
    case 'generate_practice': {
      const p = data?.practices?.[0];
      return `已为最薄弱的 ${data?.practices?.length ?? 0} 位同学生成练习，例如 ${p?.name ?? '-'} 的薄弱点是「${
        p?.weakPoint ?? '-'
      }」，配套 ${p?.items?.length ?? 0} 道针对性题目，可直接下发。`;
    }
    default:
      return '我目前能帮你：批改作业、看学情报告、列预警名单、生成个性化练习。你想先看哪一个？';
  }
}

/* ───────────────────────── 小工具 ───────────────────────── */

export function defaultRubric(type = 'code') {
  // 题型注册表是唯一来源：新增题型只需改 lib/grading/types.js
  const t = TYPES[type] || TYPES.math;
  return { type, dimensions: t.rubric };
}

/** 稳定哈希：保证「同一输入永远同一输出」，便于一致性测试 */
function hashInt(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function extractTerms(text) {
  return Array.from(
    new Set(
      (text.match(/[\u4e00-\u9fa5]{2,4}|[A-Za-z]{2,}/g) || []).filter((t) => t.length >= 2)
    )
  ).slice(0, 6);
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
