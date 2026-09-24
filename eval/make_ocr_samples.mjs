/**
 * 生成「合成」手写 transcription 测试样本
 *
 * 用途：在没有真实手写照片时，先验证「图片 → 转录 → 合并 → 批改」整条链路是否通畅。
 * ⚠️ 这些图是印刷体渲染出来的，不是真手写。它验证的是工程链路，不是真实识别率——
 *    最终写进比赛报告的数字，必须用 eval/ocr/ 里的真实手写照片跑出来。
 *
 * 用法：npm run ocr:samples        （产物在 eval/ocr-synth/）
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const OUT = resolve(process.cwd(), 'eval/ocr-synth');
const FONT = 'STXingkai, KaiTi, Microsoft YaHei, SimSun, sans-serif';

/** @type {Array<{name:string, lines:string[], degrade:number, note:string}>} */
const SAMPLES = [
  {
    name: 's1-math',
    note: '数学解答题 · 印刷体清晰版',
    degrade: 0,
    lines: [
      '解：设等差数列首项为 a1，末项为 an，项数为 n。',
      'Sn = a1 + a2 + ... + an',
      '将其倒序写，两式相加：',
      '2Sn = (a1+an) + (a2+a(n-1)) + ... + (an+a1)',
      '因为每一组的和都等于 a1+an，一共有 n 组，',
      '所以 2Sn = n(a1+an)，即 Sn = n(a1+an)/2。',
    ],
  },
  {
    name: 's2-code',
    note: '代码题 · 含缩进与复杂度说明',
    degrade: 0,
    lines: [
      'def binary_search(arr, target):',
      '    left, right = 0, len(arr) - 1',
      '    while left <= right:',
      '        mid = (left + right) // 2',
      '        if arr[mid] == target:',
      '            return mid',
      '        elif arr[mid] < target:',
      '            left = mid + 1',
      '        else:',
      '            right = mid - 1',
      '    return -1',
      '# 时间复杂度 O(log n)，空间复杂度 O(1)',
    ],
  },
  {
    name: 's3-choice',
    note: '选择题+简答 · 混合排版',
    degrade: 1,
    lines: [
      '1. 下列排序算法平均时间复杂度为 O(n log n) 的是（  B  ）',
      '理由：快排、归并的平均复杂度都是 O(n log n)，冒泡是 O(n^2)。',
      '',
      '2. 简述栈和队列的区别。',
      '答：栈是后进先出 LIFO，只允许在栈顶插入删除；',
      '队列是先进先出 FIFO，在队尾插入、队头删除。',
    ],
  },
  {
    name: 's4-poor',
    note: '模拟弱光拍摄 · 已加模糊降质',
    degrade: 2,
    lines: [
      '证明：由 Sn = a1 + a2 + ... + an，',
      '两边同时乘以公比 q，得 qSn = a2 + a3 + ... + a(n+1)，',
      '两式相减：(1-q)Sn = a1 - a(n+1)，',
      '故 Sn = (a1 - a(n+1)) / (1 - q)。',
    ],
  },
];

/** 多页样本：验证「两张照片合并成一份完整答案」 */
const MULTI = [
  {
    name: 'm1-page1',
    note: '多页样本第 1 页',
    lines: [
      '第 3 题：推导等比数列前 n 项和公式',
      '设首项为 a1，公比为 q（q ≠ 1）。',
      'Sn = a1 + a1q + a1q^2 + ... + a1q^(n-1)  ①',
    ],
  },
  {
    name: 'm1-page2',
    note: '多页样本第 2 页（承接上一页）',
    lines: [
      '① 式两边同乘 q：qSn = a1q + a1q^2 + ... + a1q^n  ②',
      '① - ② 得：(1-q)Sn = a1 - a1q^n',
      '所以 Sn = a1(1-q^n) / (1-q)，q ≠ 1。',
    ],
  },
];

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildSvg(lines, { mono = false } = {}) {
  const font = mono ? 'Consolas, Courier New, monospace' : FONT;
  const size = mono ? 26 : 30;
  const lineHeight = mono ? 40 : 46;
  const pad = 60;
  const height = Math.max(400, pad * 2 + lines.length * lineHeight);
  const body = lines
    .map((l, i) => {
      if (!l) return '';
      return `<text x="${pad}" y="${pad + (i + 1) * lineHeight}" font-size="${size}" font-family="${font}" fill="#1a1a1a" xml:space="preserve">${escapeXml(l)}</text>`;
    })
    .join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}">
  <rect width="900" height="${height}" fill="#fbfaf6"/>
  ${body}
</svg>`;
}

async function main() {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  let sharp = null;
  try {
    const m = await import('sharp');
    sharp = m.default?.default || m.default || m;
  } catch {
    console.error('需要 sharp 才能生成样本。执行：npm i sharp（本项目已随 next 附带可选依赖）');
    process.exit(1);
  }

  const written = [];
  for (const s of [...SAMPLES, ...MULTI]) {
    const mono = s.name.includes('code');
    const svg = Buffer.from(buildSvg(s.lines, { mono }));
    let img = sharp(svg);
    // 模拟真实拍摄：轻微歪斜 + 降质，让转录不是「复制粘贴」
    img = img.rotate(s.degrade >= 2 ? 1.2 : 0.7, { background: '#fbfaf6' });
    if (s.degrade >= 1) img = img.blur(s.degrade >= 2 ? 0.9 : 0.4).modulate({ brightness: s.degrade >= 2 ? 0.94 : 1.0 });
    const file = join(OUT, `${s.name}.jpg`);
    await img.jpeg({ quality: 88 }).toFile(file);
    writeFileSync(join(OUT, `${s.name}.txt`), s.lines.join('\n'), 'utf8');
    writeFileSync(join(OUT, `${s.name}.meta.json`), JSON.stringify({ note: s.note, synthetic: true, quality: s.degrade >= 2 ? 'poor' : s.degrade >= 1 ? 'medium' : 'good' }, null, 2), 'utf8');
    written.push(`${s.name}.jpg (+ .txt)`);
  }

  writeFileSync(
    join(OUT, 'README.md'),
    [
      '# 合成 OCR 自测样本',
      '',
      '这批图是**程序渲染的印刷体**，不是真实手写。它的作用只有一个：',
      '验证「上传多张图 → 预处理 → 分页转录 → 合并 → 批改」这条链路是否通畅。',
      '',
      '> 最终写进比赛报告的真实识别率，请用 `eval/ocr/` 里的**真实手写照片**跑 `npm run eval:ocr`。',
      '',
      '## 用法',
      '```bash',
      'npm run eval:ocr -- --dir eval/ocr-synth',
      '```',
      '',
      `## 样本清单（${written.length} 个）`,
      ...written.map((w) => `- ${w}`),
      '',
      '其中 `m1-page1` + `m1-page2` 是一道大题的两页，可用于验证多图合并批改。',
    ].join('\n'),
    'utf8'
  );

  console.log(`已生成 ${written.length} 个合成样本 → ${OUT}`);
  console.log('跑一下：npm run eval:ocr -- --dir eval/ocr-synth');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
