/**
 * 把混元 API Key 写进 .env.local（该文件已在 .gitignore，不会进 Git）
 *
 * 用法：
 *   npm run key -- sk-xxxxxxxxxxxxxxxx
 *   npm run key -- --show            # 只看当前配置，不改动
 *   npm run key -- --clear           # 删除已配置的 Key（回到 MOCK 模式）
 *
 * 合规提醒：Key 只落在本机 .env.local，绝不写进代码/文档/仓库。
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const target = resolve(root, '.env.local');
const arg = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));

if (flags.has('--show')) {
  if (!existsSync(target)) {
    console.log('尚未创建 .env.local，当前将运行在 MOCK 模式');
    process.exit(0);
  }
  const masked = readFileSync(target, 'utf8').replace(
    /^(HUNYUAN_API_KEY\s*=\s*)(.{0,4}).*(.{0,4})$/m,
    (_, a, head, tail) => `${a}${head}${'*'.repeat(8)}${tail}`
  );
  console.log(masked);
  process.exit(0);
}

if (flags.has('--clear')) {
  if (!existsSync(target)) {
    console.log('没有 .env.local 可清理');
    process.exit(0);
  }
  const kept = readFileSync(target, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*HUNYUAN_API_KEY\s*=/.test(l))
    .join('\n');
  writeFileSync(target, kept, 'utf8');
  console.log('已移除 HUNYUAN_API_KEY，下次启动将回到 MOCK 模式');
  process.exit(0);
}

if (!arg) {
  console.error('用法：npm run key -- <你的混元APIKey>');
  console.error('      npm run key -- --show / --clear');
  process.exit(1);
}
if (!/^sk-[\w-]{8,}$/i.test(arg.trim())) {
  console.error('这个 Key 的格式看起来不对（混元 Key 通常以 sk- 开头）。若确实如此，请手工编辑 .env.local');
  process.exit(1);
}

let content = existsSync(target) ? readFileSync(target, 'utf8') : '# 本地密钥与参数配置（本文件已被 .gitignore 忽略，请勿提交）\n';
const line = `HUNYUAN_API_KEY=${arg.trim()}`;
if (/^\s*HUNYUAN_API_KEY\s*=/m.test(content)) {
  content = content.replace(/^\s*HUNYUAN_API_KEY\s*=.*$/m, line);
} else {
  content = content.replace(/\n*$/, '\n') + line + '\n';
}
writeFileSync(target, content, 'utf8');
try {
  chmodSync(target, 0o600); // 只有本人可读，防止演示机器上被别的进程捞走
} catch {
  /* Windows 上 chmod 可能无效，忽略 */
}
console.log(`已写入 ${target}`);
console.log('下一步：npm run demo  然后打开 http://127.0.0.1:3111 ，看右上角是否显示「混元真实模型」');
