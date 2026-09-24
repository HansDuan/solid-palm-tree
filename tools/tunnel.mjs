/**
 * ClassPilot 公网隧道守护进程（零依赖，只用 Node 内置模块）
 *
 * 背景：免费 SSH 隧道（serveo / localhost.run）会不定期被服务端 reset，
 * 之前的 bash 循环退静默掉线 → 外地同学打开旧链接就是错误页。
 * 本脚本负责：建立隧道 → 抽出公网 URL → 写入 .run/current-url.txt
 *            → 每 45s 自检 → 掉线自动重连（等待退避）→ 多级 provider 回退。
 *
 * 用法：
 *   node tools/tunnel.mjs                 # 默认 localhost.run，失败回退 serveo
 *   node tools/tunnel.mjs --provider serveo
 *   node tools/tunnel.mjs --port 3111
 *
 * 注意：本机 demo 服务必须已跑起来（默认 127.0.0.1:3111）。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { get } from 'node:https';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const URL_FILE = resolve(ROOT, '.run/current-url.txt');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT = Number(arg('port', 3111));
const KEYFILE = resolve(ROOT, '.run/serveo_key');

/** provider 定义：priority 小的先用 */
const PROVIDERS = {
  'localhost.run': {
    // 匿名隧道，无需密钥；重装后域名会变。想固化需注册账号并绑定公钥。
    args: [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=NUL',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ConnectTimeout=25',
      '-R', `80:localhost:${PORT}`,
      'nokey@localhost.run',
    ],
    re: /https:\/\/[a-z0-9-]+\.lhr\.life/,
  },
  serveo: {
    args: [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=NUL',
      '-o', 'IdentitiesOnly=yes',
      '-i', KEYFILE,
      '-o', 'ServerAliveInterval=10',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ConnectTimeout=25',
      '-R', `80:localhost:${PORT}`,
      'serveo.net',
    ],
    re: /https:\/\/[a-z0-9-]+\.serveousercontent\.com/,
  },
};

const ORDER = arg('provider') ? [arg('provider')] : ['localhost.run', 'serveo', 'localhost.run', 'serveo', 'localhost.run'];

let slot = 0;
let child = null;
let currentUrl = null;
let restarting = false;
let fastFails = 0; // 连续“秒退”次数 → 指数退避，避免打爆服务商

const log = (...m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...m);

/**
 * ssh 定位：守护进程脱离会话（PowerShell Start-Process 隐藏窗口）运行时，
 * PATH 里没有 Git 的 ssh → spawn 直接失败。必须退回 Windows 自带 OpenSSH 绝对路径。
 */
const SSH_CANDIDATES = [
  // ① MSYS(Git) ssh：实测在无控制台的 detached 子进程里稳定；Windows 自带 OpenSSH 会秒退(0xC0000001)
  'C:/Users/Administrator/.learnbuddy/vendor/PortableGit/usr/bin/ssh.exe',
  'C:/Program Files/Git/usr/bin/ssh.exe',
  // ② 兜底：Windows 自带 OpenSSH（仅在候选①都不存在时使用）
  'C:/Windows/System32/OpenSSH/ssh.exe',
];
const SSH_BIN = SSH_CANDIDATES.find((p) => existsSync(p)) || 'ssh';
log('使用 ssh:', SSH_BIN);

function saveUrl(url) {
  currentUrl = url;
  try {
    writeFileSync(URL_FILE, `${url}\n`, 'utf8');
  } catch (e) {
    log('写地址文件失败:', e.message);
  }
  log(`✅ 公网地址已就绪: ${url}`);
}

function start() {
  if (restarting) return;
  restarting = true;
  const name = ORDER[slot % ORDER.length];
  const p = PROVIDERS[name];

  log(`→ 连接 ${name} ...`);
  const bornAt = Date.now();
  child = spawn(SSH_BIN, p.args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

  child.on('error', (e) => log(`[${name}] spawn 失败: ${e.message}`));
  child.stdout.on('data', (b) => {
    const s = b.toString();
    const m = s.match(p.re);
    if (m) { saveUrl(m[0]); fastFails = 0; }
    if (/expired|Connection reset|denied|administratively prohibited/i.test(s)) {
      log(`${name} 输出异常: ${s.trim().split('\n')[0]}`);
      bump();
    }
  });
  child.stderr.on('data', (b) => {
    const s = b.toString().trim();
    if (s && !/Pseudo-terminal|known hosts/.test(s)) log(`[${name}:err] ${s}`);
  });
  child.on('exit', (code) => {
    if (Date.now() - bornAt < 15000) fastFails += 1; else fastFails = 0;
    const delay = Math.min(3000 * fastFails, 60000);
    log(`${name} 退出 (code=${code})，${delay / 1000}s 后重连`);
    setTimeout(bump, delay);
  });

  restarting = false;
}

function bump() {
  slot += 1;
  if (child && !child.killed) { try { child.kill('SIGTERM'); } catch {} }
  setTimeout(start, 1000);
}

/** 自检：直连公网 URL，连续 2 次失败才判定掉线（避免偶发抖动误杀） */
let failStreak = 0;
function selfcheck() {
  if (!currentUrl) return;
  const req = get(currentUrl + '/api/health', { timeout: 20000 }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      if (res.statusCode === 200 && body.includes('"ok":true')) {
        failStreak = 0;
      } else {
        log(`自检异常 http=${res.statusCode}`);
        failStreak += 1;
      }
    });
  });
  req.on('timeout', () => { req.destroy(); failStreak += 1; log('自检超时'); });
  req.on('error', () => { failStreak += 1; log('自检连接失败'); });

  if (failStreak >= 2) {
    failStreak = 0;
    log('连续自检失败，重建隧道');
    bump();
  }
}

setInterval(selfcheck, 45000);
start();

process.on('SIGINT', () => { if (child) child.kill(); process.exit(0); });
