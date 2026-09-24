/**
 * 多模态入口：图片 / 文档 → 文本 → 交给同一条批改 pipeline
 *
 * 两步流程的好处：识别不好时可以降级成「AI 转录 + 教师页面校对 + 批改」，不算翻车。
 * 多页场景统一走 lib/parse/multi.js，本文件只保留单文件的兼容入口。
 */
import { extractFromFiles, MAX_PAGES } from './multi.js';

export { MAX_PAGES };

/**
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {{courseHint?:string}} [opts]
 * @returns {Promise<{source:string, text:string, transcript:string|null, mock:boolean, pages:Array, warnings:string[]}>}
 */
export async function extractSubmissionText(buffer, filename, opts = {}) {
  const r = await extractFromFiles([{ buffer, filename }], opts);
  return {
    source: r.source,
    text: r.text,
    transcript: r.transcript,
    mock: r.mock,
    pages: r.pages,
    warnings: r.warnings,
    stats: r.stats,
    elapsedMs: r.elapsedMs,
  };
}
