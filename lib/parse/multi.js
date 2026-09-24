/**
 * 多图 / 混传合并提取 —— 一次作业拍了 3 页也能批
 *
 * 真实课堂里，一道解答题写满两页是常态。只传第一页会让老师看到「步骤不完整 → 扣分」，
 * 那是对学生的误判。所以：多页各自转录 → 按原顺序拼成完整答案 → 再进同一条批改 pipeline。
 *
 * 三条工程红线：
 *  1. 并发上限 2 —— 视觉模型是按图计费且吃内存，串行太慢、并发太满会 OOM/429。
 *  2. 单页失败不拖垮整份 —— 收集 warning 继续，只有「全部失败」才抛错。
 *  3. 顺序稳定 —— 页码信息写进 prompt，合并结果必须与拍摄顺序一致。
 */
import { parseFile } from './file.js';
import { vision, isMock } from '../grading/llm.js';
import { buildTranscribePrompt } from '../grading/prompts.js';
import { preprocessImage, guardHeap, LIMITS } from './image.js';

export const MAX_PAGES = Number(process.env.MAX_PAGES || 6);
const CONCURRENCY = Number(process.env.OCR_CONCURRENCY || 2);

/** 受控并发 map：保持输出顺序，单个失败不影响整体 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

function dedupeAdjacent(lines) {
  const out = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    // 相邻行完全相同 → 大概率是跨页重复识别到了同一个标题/题号（学生常每题抄一遍题头）
    if (prev !== undefined && prev === l) continue;
    out.push(l);
  }
  return out;
}

function mergePageTexts(texts) {
  const lines = [];
  for (const t of texts) {
    for (const l of String(t).split('\n')) {
      const trimmed = l.replace(/\s+$/, '');
      if (!trimmed.trim()) continue;
      if (/^\[空白页\]$/.test(trimmed.trim())) continue;
      lines.push(trimmed);
    }
  }
  return dedupeAdjacent(lines).join('\n').trim();
}

/**
 * @param {Array<{buffer:Buffer, filename:string}>} entries
 * @param {{courseHint?:string}} [opts]
 * @returns {Promise<{source:'file'|'image'|'mixed', text:string, transcript:string|null,
 *   mock:boolean, pages:Array<object>, warnings:string[], elapsedMs:number, stats:object}>}
 */
export async function extractFromFiles(entries, opts = {}) {
  const started = Date.now();
  const list = (entries || []).filter((e) => e && e.buffer);
  if (!list.length) throw new Error('没有收到任何文件内容，请重新选择文件或照片');
  if (list.length > MAX_PAGES) {
    throw new Error(`一次最多处理 ${MAX_PAGES} 个文件，本次收到 ${list.length} 个。请分批处理（多页作业建议先合成一个 PDF 或分批上传）`);
  }

  const imageIdxs = [];
  const parsed = await Promise.all(
    list.map(async (e, i) => {
      const p = await parseFile(e.buffer, e.filename);
      if (p.type === 'image') imageIdxs.push(i);
      return p;
    })
  );

  const totalImageBytes = imageIdxs.reduce((s, i) => s + list[i].buffer.length, 0);
  if (totalImageBytes) guardHeap(totalImageBytes, `处理 ${imageIdxs.length} 张作业照片`);

  const imageTotal = imageIdxs.length;
  const warnings = [];
  const pages = await mapLimit(parsed, CONCURRENCY, async (p, i) => {
    const filename = list[i].filename;
    if (p.type === 'text') {
      return {
        index: i + 1,
        filename,
        source: 'file',
        text: p.text || '',
        mock: false,
        elapsedMs: 0,
        bytes: list[i].buffer.length,
        meta: null,
      };
    }
    // ── 图片页 ──
    const t0 = Date.now();
    try {
      const pre = await preprocessImage(list[i].buffer, p.mimeType, filename);
      const pageNo = imageIdxs.indexOf(i) + 1;
      const text = await vision({
        prompt: buildTranscribePrompt({ pageIndex: pageNo, pageTotal: imageTotal, courseHint: opts.courseHint }),
        imageBase64: pre.buffer.toString('base64'),
        mimeType: pre.mimeType,
      });
      return {
        index: i + 1,
        filename,
        source: 'image',
        text: String(text || '').trim(),
        mock: isMock(),
        elapsedMs: Date.now() - t0,
        bytes: list[i].buffer.length,
        meta: pre.meta,
      };
    } catch (e) {
      warnings.push(`第 ${i + 1} 页（${filename}）识别失败：${e.message}`);
      return {
        index: i + 1,
        filename,
        source: 'image',
        text: '',
        mock: isMock(),
        elapsedMs: Date.now() - t0,
        bytes: list[i].buffer.length,
        meta: null,
        error: e.message,
      };
    }
  });

  const imagePages = pages.filter((p) => p.source === 'image');
  const failed = imagePages.filter((p) => p.error);
  if (imagePages.length && failed.length === imagePages.length) {
    // 全军覆没才抛错——宁可整体重试，也不要给老师一份“假的成功”
    throw new Error(`全部 ${imagePages.length} 张照片都未识别成功。首个错误：${failed[0].error}`);
  }
  const blankPages = imagePages.filter((p) => !p.error && /^\[空白页\]$/.test(p.text));
  if (blankPages.length) warnings.push(`第 ${blankPages.map((p) => p.index).join('、')} 页未检测到字迹，已跳过（确认一下是不是拍到了背面）`);

  const text = mergePageTexts(pages.map((p) => p.text));
  const transcript =
    imagePages.length && imagePages.some((p) => p.text)
      ? imagePages
          .filter((p) => p.text)
          .map((p) => (imageTotal > 1 ? `── 第 ${imageIdxs.indexOf(p.index - 1) + 1} 页 ──\n${p.text}` : p.text))
          .join('\n')
      : null;

  const source = !imagePages.length ? 'file' : imagePages.length === pages.length ? 'image' : 'mixed';
  return {
    source,
    text,
    transcript,
    mock: imagePages.length ? imagePages.every((p) => p.mock !== false) : false,
    pages,
    warnings,
    elapsedMs: Date.now() - started,
    stats: {
      totalPages: pages.length,
      imagePages: imagePages.length,
      textPages: pages.length - imagePages.length,
      failedPages: failed.length,
      charCount: text.length,
      largestInputBytes: Math.max(...pages.map((p) => p.bytes || 0)),
      limits: LIMITS,
    },
  };
}
