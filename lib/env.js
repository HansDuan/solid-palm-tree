/**
 * 轻量 .env.local 加载器（零依赖）。
 *
 * 为什么需要它：demo/server.mjs 与 eval 脚本是纯 Node 进程，不会像 Next.js 那样
 * 自动读取 .env.local。不加载的话，HUNYUAN_API_KEY 进不了 process.env，
 * 真实模型链路口会一直掉进 MOCK —— 这正是「写了 Key 却跑不起来真实模型」的常见根因。
 *
 * 用法：在入口文件最顶部 `import './env.js';`（副作用即生效，先于其它模块的 env 读取）。
 * 规则：只补充、不覆盖 —— 若进程_env 已有该变量（如 shell 已 export、或 --env-file 传入），以已有为准。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CANDIDATES = ['.env.local', '.env'];

export function loadEnvLocal() {
  for (const name of CANDIDATES) {
    const p = resolve(process.cwd(), name);
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      const val = m[2];
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}

// 导入即执行
loadEnvLocal();
