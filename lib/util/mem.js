/**
 * 内存护栏 —— 防止“多图批量上传”把 node 进程打挂（OOM）
 *
 * 为什么必须：一次 8MB 的照片在请求链路上会同时存在三份以上
 * （原始 Buffer + base64 字符串 + JSON 序列化副本 + fetch body），
 * 实际占用是文件体积的 3~4 倍。并发 5 张就是上百 MB。
 */
const DEFAULT_HEAP_MB = Number(process.env.MAX_HEAP_MB || 1024);

/** 建议 Ethan 值：Node V8 在 --max-old-space-size 超过物理内存一半时会频繁 GC */
export function heapBudgetBytes() {
  return DEFAULT_HEAP_MB * 1024 * 1024;
}

/**
 * 预检：把即将进堆的体积（3 倍估算）与当前堆用量加总，超过预算 90% 就提前失败
 * 提前失败 >> OOM 崩溃：前者能给用户一句“请减少张数”，后者是演示现场白屏
 * @param {number} bytes 本次请求体/图片的近似字节数
 * @param {string} label 出错时的提示主语
 */
export function guardHeap(bytes, label) {
  const limit = heapBudgetBytes();
  const { heapUsed } = process.memoryUsage();
  const need = bytes * 3;
  if (heapUsed + need > limit * 0.9) {
    throw new Error(
      `可用内存不足，无法继续${label}：本次约需 ${(need / 1048576).toFixed(0)}MB，堆已用 ${(
        heapUsed / 1048576
      ).toFixed(0)}MB。请减少单次上传张数（建议 ≤3 张）或压缩后重试；若机器内存充裕，可设置 MAX_HEAP_MB=2048`
    );
  }
  return true;
}

/** 当前堆健康度，给前端 /health 或演示页展示用 */
export function heapSnapshot() {
  const { heapUsed, heapTotal, rss } = process.memoryUsage();
  return {
    heapUsedMb: +(heapUsed / 1048576).toFixed(1),
    heapTotalMb: +(heapTotal / 1048576).toFixed(1),
    rssMb: +(rss / 1048576).toFixed(1),
    budgetMb: DEFAULT_HEAP_MB,
    usagePct: Math.round((heapUsed / (DEFAULT_HEAP_MB * 1024 * 1024)) * 100),
  };
}
