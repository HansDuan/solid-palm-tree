/**
 * 手写照片转录评测 —— 给「拍照上传批改」这条链路出真实数据
 *
 * 用法：
 *   npm run eval:ocr                      跑默认数据集 eval/ocr/
 *   npm run eval:ocr -- --dir eval/ocr-synth   跑指定的一批
 *   npm run eval:ocr -- --repeat 3        每张跑 3 次，顺便看稳定性
 *   npm run eval:ocr -- --no-key           强制用当前模式跑（不额外提示）
 *
 * 数据集约定（放图片和标准答案同名文件即可）：
 *   eval/ocr/hw01.jpg      手机/扫描的作业照片
 *   eval/ocr/hw01.txt      人工逐字录入的标准文本
 *   eval/ocr/hw01.meta.json（可选）{"note":"晚自习灯光","quality":"poor"}
 *
 * 三个指标各有分工，别只看一个：
 *   CER（字符错误率）        —— 转录得像不像
 *   行命中率                 —— 结构有没有乱（批改按句取证据，结构乱了证据就找错位置）
 *   批改要点召回率            —— 决定分数的那几个关键词保没保住  ★最关键
 */
import '../lib/env.js'; // 加载 .env.local，使真实模式在纯 Node 评测脚本下也能激活
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, basename, join } from 'node:path';
import { extractFromFiles } from '../lib/parse/multi.js';
import { currentMode, runtimeConfig, isMock } from '../lib/grading/llm.js';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const DIR = resolve(process.cwd(), argOf('--dir', null) || 'eval/ocr');
const REPEAT = Math.max(1, Number(argOf('--repeat', 1) || 1));
const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];

/* ── 文本归一化：评测比的是「信息是否一致」，不是「排版是否一致」 ── */
const FULL2HALF =
  '　０１２３４５６７８９ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ';
const HALF = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function normalize(s) {
  let s2 = String(s || '').replace(/\s+/g, '');
  for (let i = 0; i < FULL2HALF.length; i++) s2 = s2.split(FULL2HALF[i]).join(HALF[i]);
  return s2
    .replace(/[，、]/g, ',')
    .replace(/[。．]/g, '.')
    .replace(/[：]/g, ':')
    .replace(/[；]/g, ';')
    .replace(/[？]/g, '?')
    .replace(/[！]/g, '!')
    .replace(/[（）]/g, (c) => (c === '（' ? '(' : ')'))
    .replace(/[「」『』""]/g, '"')
    .replace(/[—－–]/g, '-')
    .toLowerCase();
}

/** Levenshtein 编辑距离（双行滚动数组，长文本也不炸内存） */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/** CER：编辑距离 / 标准答案长度 */
function cer(ref, hyp) {
  const r = normalize(ref);
  const h = normalize(hyp);
  if (!r.length) return h.length ? 1 : 0;
  return Math.min(1, levenshtein(r, h) / r.length);
}

/** 行命中率：用最长公共子序列做有序对齐，避免「少识别一行就后面全错」的误杀 */
function lineHit(ref, hyp) {
  const rl = String(ref).split('\n').map(normalize).filter(Boolean);
  const hl = String(hyp).split('\n').map(normalize).filter(Boolean);
  if (!rl.length) return hl.length ? 0 : 1;
  const dp = Array.from({ length: rl.length + 1 }, () => new Uint16Array(hl.length + 1));
  for (let i = 1; i <= rl.length; i++) {
    for (let j = 1; j <= hl.length; j++) {
      dp[i][j] = rl[i - 1] === hl[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[rl.length][hl.length] / rl.length;
}

/** 批改要点召回：决定分数的关键词有没有保住 */
const STOP = new Set(['解：', '的', '了', '是', '在', '和', '与', '因为', '所以', '由', '则', '故', '即', '这', '那']);
function keyTerms(text) {
  const raw = String(text || '');
  const terms = new Set();
  for (const t of raw.match(/[\u4e00-\u9fa5]{2,6}/g) || []) if (!STOP.has(t)) terms.add(t);
  for (const t of raw.match(/[A-Za-z][A-Za-z0-9_().^]{2,}/g) || []) terms.add(t.toLowerCase());
  for (const t of raw.match(/O\([^)]*\)|O\([n^2]+\)|[0-9]+\/[0-9]+/gi) || []) terms.add(t.replace(/\s/g, ''));
  // 去掉被长词完全包含的短词，避免「复杂度」和「时间复杂度」重复计数
  const list = [...terms];
  return list.filter((t) => !list.some((o) => o !== t && o.includes(t))).slice(0, 60);
}

function termRecall(ref, hyp) {
  const terms = keyTerms(ref);
  if (!terms.length) return 1;
  const h = normalize(hyp);
  const hit = terms.filter((t) => h.includes(normalize(t)));
  return { recall: hit.length / terms.length, missed: terms.filter((t) => !h.includes(normalize(t))) };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const p = (a, q) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(s.length * q) - 1)];
};

async function imageMeta(buffer) {
  try {
    const m = await import('sharp');
    const sharp = m.default?.default || m.default || m;
    const md = await sharp(buffer).metadata();
    return { width: md.width || null, height: md.height || null, format: md.format || null };
  } catch {
    return { width: null, height: null, format: null };
  }
}

async function main() {
  if (!existsSync(DIR)) {
    mkdirSync(DIR, { recursive: true });
    console.log(`已创建空数据集目录：${DIR}`);
    console.log('往里面放：hw01.jpg + hw01.txt（人工逐字录入的标准答案），再跑 npm run eval:ocr');
    return;
  }
  const files = readdirSync(DIR).filter((f) => IMG_EXT.includes(extname(f).toLowerCase())).sort();
  if (!files.length) {
    console.log(`${DIR} 里没有图片。放几张手写作业照片（再配同名 .txt 标准答案）后重试。`);
    console.log('没有标准答案也能跑：只出耗时 / [?] 密度 / 转录稿，用于肉眼挑 bug。');
    return;
  }

  console.log('=' .repeat(78));
  console.log('ClassPilot · 手写照片转录评测');
  console.log('模式：' + currentMode() + (isMock() ? '   ← 没有 Key，结果是模拟转录，不可用于最终报告' : '   ← 真实混元视觉模型'));
  console.log(`视觉模型：${runtimeConfig().imageModel}   超时：${runtimeConfig().visionTimeoutMs}ms   并发上限：2   重复次数：${REPEAT}`);
  console.log(`数据集：${DIR}（${files.length} 张）`);
  console.log('='.repeat(78));

  const rows = [];
  for (const f of files) {
    const buffer = readFileSync(join(DIR, f));
    const gtPath = join(DIR, basename(f, extname(f)) + '.txt');
    const hasGt = existsSync(gtPath);
    const groundTruth = hasGt ? readFileSync(gtPath, 'utf8') : '';
    let metaNote = '';
    const metaPath = join(DIR, basename(f, extname(f)) + '.meta.json');
    if (existsSync(metaPath)) {
      try { metaNote = JSON.parse(readFileSync(metaPath, 'utf8')).note || ''; } catch { metaNote = ''; }
    }

    const runs = [];
    for (let i = 0; i < REPEAT; i++) {
      const t0 = Date.now();
      try {
        const r = await extractFromFiles([{ buffer, filename: f }]);
        const text = r.pages?.[0]?.text ?? '';
        runs.push({
          ok: true,
          text,
          elapsedMs: Date.now() - t0,
          engine: r.pages?.[0]?.meta?.engine || 'passthrough',
          savedPct: r.pages?.[0]?.meta?.savedPct ?? null,
          afterBytes: r.pages?.[0]?.meta?.afterBytes ?? null,
          mock: r.mock,
        });
      } catch (e) {
        runs.push({ ok: false, error: String(e.message || e), elapsedMs: Date.now() - t0 });
      }
    }
    const okRuns = runs.filter((r) => r.ok);
    const best = okRuns[0] || { text: '' };

    const q = (best.text.match(/\[\?\]/g) || []).length;
    const row = {
      file: f,
      hasGroundTruth: hasGt,
      note: metaNote,
      ok: okRuns.length > 0,
      successRate: okRuns.length / runs.length,
      elapsedMs: Math.round(mean(okRuns.map((r) => r.elapsedMs))),
      charCount: best.text.length,
      unknownMarks: q,
      unknownDensity: best.text.length ? +(q / best.text.length).toFixed(4) : 0,
      engine: best.engine || '-',
      savedPct: best.savedPct,
      afterBytes: best.afterBytes,
      mock: Boolean(best.mock),
      error: okRuns.length ? null : runs[0].error,
    };
    if (hasGt && row.ok) {
      const cers = okRuns.map((r) => cer(groundTruth, r.text));
      const lh = okRuns.map((r) => lineHit(groundTruth, r.text));
      const tr = okRuns.map((r) => termRecall(groundTruth, r.text).recall);
      const { missed } = termRecall(groundTruth, best.text);
      row.cer = +mean(cers).toFixed(4);
      row.cerStd = +(Math.max(...cers) - Math.min(...cers)).toFixed(4);
      row.lineHit = +mean(lh).toFixed(4);
      row.termRecall = +mean(tr).toFixed(4);
      row.missedTerms = missed.slice(0, 6);
      row.groundTruthChars = normalize(groundTruth).length;
    }
    if (REPEAT > 1 && row.ok) {
      row.consistencyNote = `${okRuns.length}/${runs.length} 次成功`;
    }
    const dims = await imageMeta(buffer);
    row.image = { ...dims, bytes: buffer.length };
    rows.push(row);
  }

  /* ── 打印明细 ── */
  console.log('\n【逐张明细】');
  console.log(
    '文件名'.padEnd(22) + '状态'.padEnd(6) + '耗时'.padEnd(8) + '字数'.padEnd(7) +
    'CER'.padEnd(9) + '行命中'.padEnd(9) + '要点召回'.padEnd(10) + '[?]'.padEnd(6) + '预处理'
  );
  console.log('-'.repeat(88));
  for (const r of rows) {
    console.log(
      r.file.slice(0, 20).padEnd(22) +
      (r.ok ? '成功' : '失败').padEnd(6) +
      `${r.elapsedMs}ms`.padEnd(8) +
      String(r.charCount).padEnd(7) +
      (r.hasGroundTruth && r.ok ? pct(r.cer).padEnd(9) : 'N/A'.padEnd(9)) +
      (r.hasGroundTruth && r.ok ? pct(r.lineHit).padEnd(9) : 'N/A'.padEnd(9)) +
      (r.hasGroundTruth && r.ok ? pct(r.termRecall).padEnd(10) : 'N/A'.padEnd(10)) +
      String(r.unknownMarks).padEnd(6) +
      `${r.engine}${r.savedPct ? ` -${r.savedPct}%` : ''}`
    );
    if (!r.ok) console.log('    └ 错误：' + r.error);
    if (r.missedTerms?.length) console.log('    └ 漏掉的批改要点：' + r.missedTerms.join('、'));
  }

  /* ── 汇总 ── */
  const okRows = rows.filter((r) => r.ok);
  const gtRows = okRows.filter((r) => r.hasGroundTruth);
  const summary = {
    mode: currentMode(),
    imageModel: runtimeConfig().imageModel,
    mock: isMock(),
    datasetDir: DIR,
    timestamp: new Date().toISOString(),
    totalImages: rows.length,
    successCount: okRows.length,
    successRate: rows.length ? +(okRows.length / rows.length).toFixed(4) : 0,
    withGroundTruth: gtRows.length,
    avgCER: gtRows.length ? +mean(gtRows.map((r) => r.cer)).toFixed(4) : null,
    maxCER: gtRows.length ? +Math.max(...gtRows.map((r) => r.cer)).toFixed(4) : null,
    avgLineHit: gtRows.length ? +mean(gtRows.map((r) => r.lineHit)).toFixed(4) : null,
    avgTermRecall: gtRows.length ? +mean(gtRows.map((r) => r.termRecall)).toFixed(4) : null,
    avgUnknownDensity: okRows.length ? +mean(okRows.map((r) => r.unknownDensity)).toFixed(4) : 0,
    latency: {
      avgMs: Math.round(mean(okRows.map((r) => r.elapsedMs))),
      p50Ms: Math.round(p(okRows.map((r) => r.elapsedMs), 0.5)),
      p95Ms: Math.round(p(okRows.map((r) => r.elapsedMs), 0.95)),
      maxMs: okRows.length ? Math.max(...okRows.map((r) => r.elapsedMs)) : 0,
    },
    repeat: REPEAT,
  };

  console.log('\n【汇总】');
  console.log(`成功率        ${pct(summary.successRate)}（${summary.successCount}/${summary.totalImages}）`);
  if (gtRows.length) {
    console.log(`平均 CER      ${pct(summary.avgCER)}   （最差 ${pct(summary.maxCER)}）`);
    console.log(`平均行命中率   ${pct(summary.avgLineHit)}`);
    console.log(`要点召回率     ${pct(summary.avgTermRecall)}   ← 决定批改会不会判错，最关键`);
  } else {
    console.log('本批没有标准答案 .txt，只出工程指标（耗时/成功率/[?] 密度）');
  }
  console.log(`[?] 密度       ${pct(summary.avgUnknownDensity)}`);
  console.log(`耗时          平均 ${summary.latency.avgMs}ms · P50 ${summary.latency.p50Ms}ms · P95 ${summary.latency.p95Ms}ms · 最慢 ${summary.latency.maxMs}ms`);

  /* ── 门槛判定 ── */
  const gates = [];
  const push = (name, pass, detail) => gates.push({ name, pass, detail });
  push('链路可用', summary.successRate >= 0.95, `${summary.successCount}/${summary.totalImages} 张成功`);
  if (gtRows.length) {
    push('平均 CER ≤ 15%', summary.avgCER <= 0.15, `实际 ${pct(summary.avgCER)}`);
    push('要点召回 ≥ 90%', summary.avgTermRecall >= 0.9, `实际 ${pct(summary.avgTermRecall)}`);
    push('行命中 ≥ 70%', summary.avgLineHit >= 0.7, `实际 ${pct(summary.avgLineHit)}`);
  }
  push('P95 延迟 ≤ 20s', summary.latency.p95Ms <= 20000, `实际 ${summary.latency.p95Ms}ms`);
  console.log('\n【门槛判定】');
  for (const g of gates) console.log(`${g.pass ? '✅ PASS' : '❌ FAIL'}  ${g.name.padEnd(18)} ${g.detail}`);
  const allPass = gates.every((g) => g.pass);

  /* ── 落盘 ── */
  const outJson = resolve(process.cwd(), 'eval/ocr-report.json');
  writeFileSync(outJson, JSON.stringify({ summary, gates, rows }, null, 2), 'utf8');

  const mdLines = [
    '### 手写照片转录评测',
    '',
    `- 模型：${summary.imageModel}（${summary.mock ? 'MOCK 模式' : '真实调用'}）｜样本：${summary.totalImages} 张手写作业照片`,
    `- 成功率 **${pct(summary.successRate)}**｜平均 CER **${summary.avgCER === null ? 'N/A' : pct(summary.avgCER)}**｜批改要点召回率 **${summary.avgTermRecall === null ? 'N/A' : pct(summary.avgTermRecall)}**`,
    `- 单张耗时：平均 ${summary.latency.avgMs}ms（P95 ${summary.latency.p95Ms}ms）`,
    '',
    '| 指标 | 数值 | 说明 |',
    '| --- | --- | --- |',
    `| 转录成功率 | ${pct(summary.successRate)} | ${summary.successCount}/${summary.totalImages} |`,
  ];
  if (gtRows.length) {
    mdLines.push(
      `| 字符错误率 CER | ${pct(summary.avgCER)} | 最差单张 ${pct(summary.maxCER)} |`,
      `| 行命中率 | ${pct(summary.avgLineHit)} | 行结构是否被保持 |`,
      `| 批改要点召回率 | ${pct(summary.avgTermRecall)} | 决定分数的关键词保住了多少 |`
    );
  }
  mdLines.push(
    `| 难以辨认占位 [?] 密度 | ${pct(summary.avgUnknownDensity)} | 越低说明看得越清 |`,
    `| P95 延迟 | ${summary.latency.p95Ms}ms | 含网络往返 |`
  );
  const outMd = resolve(process.cwd(), 'eval/ocr-report.md');
  writeFileSync(outMd, mdLines.join('\n') + '\n', 'utf8');

  console.log(`\n报告已写出：${outJson}`);
  console.log(`可直接贴进作品文档的表格：${outMd}`);
  if (summary.mock) {
    console.log('\n⚠️  当前是 MOCK 模式，以上数字是模拟转录的结果，只能用于验证管线，不能写进最终报告。');
    console.log('   拿到混元 Key 后执行：npm run key -- <你的Key>，再重跑本脚本即为真实数据。');
  }
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error('评测脚本异常：', e);
  process.exit(1);
});
