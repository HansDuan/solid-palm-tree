/**
 * 图片前置处理 —— OOM 与识别效果的第一道防线
 *
 * 为什么要做：
 *  - 手机直接拍的作业照片动辄 4000×3000 / 5~8MB，base64 后体积再涨 33%，
 *    批量并发时堆内存瞬间打满 → node OOM 崩溃；同时大图对视觉模型也是无效 token。
 *  - 手机照片常有 EXIF 方向标记，不转正就是横着/倒着的图，识别率断崖式下跌。
 *  - 客户较弱时（安卓老机型）客户端压缩可能失效，服务端必须兜得住。
 *
 * 设计原则：sharp 不可用时「静默降级」而不是报错——sharp 只是 next 的可选依赖，
 * 删掉 node_modules 重装也不该让演示失败。
 */
import { guardHeap } from '../util/mem.js';

const MAX_IMAGE_BYTES = Number(process.env.IMAGE_MAX_BYTES || 12 * 1024 * 1024); // 上传硬上限
export const TARGET_EDGE = Number(process.env.IMAGE_MAX_EDGE || 1600); // 长边目标
const TARGET_BYTES = Number(process.env.IMAGE_TARGET_BYTES || 1.6 * 1024 * 1024); // 压缩后目标
const MIN_EDGE = 640; // 再小就丢笔画了，停止压缩

let sharpPromise = null;
let sharpResolved = null;

/**
 * 延迟探测 sharp，结果缓存。
 * 注意必须缓存 Promise 本身而不是结果：并发 2 张图同时进来时，
 * 若先置 flag 再 await import，第二张会拿到“还没加载完”的 null（真实发生过）。
 */
function getSharp() {
  if (process.env.IMAGE_DISABLE_SHARP === '1') return Promise.resolve(null);
  if (!sharpPromise) {
    sharpPromise = import('sharp')
      .then((mod) => {
        sharpResolved = mod.default?.default || mod.default || mod || null;
        return sharpResolved;
      })
      .catch(() => {
        sharpResolved = null;
        return null;
      });
  }
  return sharpPromise;
}

export function imagePreprocessAvailable() {
  return sharpResolved !== null && sharpResolved !== undefined;
}

/** 堆内存预检统一实现在 lib/util/mem.js，这里再导出，方便调用方单点 import */
export { guardHeap };

/**
 * 图片预处理：体积硬校验 → EXIF 转正 → 长边缩放 → 白底压 JPEG
 * @param {Buffer} buffer 原始图片
 * @param {string} mimeType
 * @param {string} filename 仅用于报错友好提示
 * @returns {Promise<{buffer:Buffer, mimeType:string, meta:object}>}
 */
export async function preprocessImage(buffer, mimeType = 'image/jpeg', filename = 'photo') {
  const beforeBytes = buffer.length;
  if (beforeBytes > MAX_IMAGE_BYTES) {
    throw new Error(
      `${filename} 大小 ${(beforeBytes / 1048576).toFixed(1)}MB，超过上限 ${(
        MAX_IMAGE_BYTES / 1048576
      ).toFixed(0)}MB。请用手机自带编辑裁一下，或改传「中等画质」版本。`
    );
  }
  if (!beforeBytes) throw new Error(`${filename} 内容为空，请重新拍摄`);

  const base = { beforeBytes, afterBytes: beforeBytes, width: null, height: null, engine: 'passthrough' };
  const sharp = await getSharp();
  if (!sharp) return { buffer, mimeType, meta: { ...base, engine: 'passthrough(no-sharp)' } };
  try {
    let pipeline = sharp(buffer, { failOn: 'none' }).rotate(); // rotate() 无参数 = 按 EXIF 自动转正
    let out = await pipeline.jpeg({ quality: 88, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer();
    let meta = await sharp(out).metadata();

    const longest = Math.max(meta.width || 0, meta.height || 0);
    if (longest > TARGET_EDGE) {
      out = await sharp(out)
        .rotate()
        .resize({ width: TARGET_EDGE, height: TARGET_EDGE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 86, chromaSubsampling: '4:4:4', mozjpeg: true })
        .toBuffer();
      meta = await sharp(out).metadata();
    }

    // 极端情况（密密麻麻的铅字 rab）：逐步降质直到进目标体积，但不低于最低边长
    const qualities = [78, 68, 58, 48];
    let qi = 0;
    while (out.length > TARGET_BYTES && qi < qualities.length && (meta.width || 0) > MIN_EDGE) {
      const shrink = qi >= 2 ? 0.82 : 1;
      const w = Math.max(MIN_EDGE, Math.round((meta.width || TARGET_EDGE) * shrink));
      out = await sharp(out)
        .resize({ width: w, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: qualities[qi], chromaSubsampling: '4:2:0', mozjpeg: true })
        .toBuffer();
      meta = await sharp(out).metadata();
      qi += 1;
    }

    return {
      buffer: out,
      mimeType: 'image/jpeg',
      meta: {
        beforeBytes,
        afterBytes: out.length,
        width: meta.width || null,
        height: meta.height || null,
        qualityStep: qi,
        engine: 'sharp',
        savedPct: beforeBytes ? Math.round((1 - out.length / beforeBytes) * 100) : 0,
      },
    };
  } catch (e) {
    // 预处理失败绝不阻断主流程：原图直传，让模型自己扛
    return { buffer, mimeType, meta: { ...base, engine: `passthrough(${(e.message || 'error').slice(0, 40)})` } };
  }
}

export const LIMITS = { MAX_IMAGE_BYTES, TARGET_EDGE, TARGET_BYTES, MIN_EDGE };
