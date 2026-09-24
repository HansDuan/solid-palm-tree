/**
 * 文件解析（C 同学）：统一把各种格式转成批改 pipeline 需要的纯文本
 * - .txt / .md / .csv / .py / .js / .java / .cpp  直接读
 * - .docx  内置极简 ZIP + XML 解析（零依赖）
 * - .pdf   优先用 pdf-parse（可选依赖），缺依赖时给友好提示
 * - 图片   返回 image 类型，交给多模态转录（B 同学那条链路）
 */
import { inflateRawSync } from 'node:zlib';
import { extname } from 'node:path';

const TEXT_EXT = ['.txt', '.md', '.csv', '.py', '.js', '.jsx', '.ts', '.java', '.cpp', '.c', '.html', '.json'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.bmp': 'image/bmp' };

/** 极简 ZIP 读取：找到指定 entry 并返回解压后的 Buffer */
function readZipEntry(buf, wantedName) {
  let offset = 0;
  while (offset < buf.length - 4) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) {
      offset += 1;
      continue;
    }
    const method = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buf.slice(nameStart, nameStart + nameLen).toString('utf8');
    const dataStart = nameStart + nameLen + extraLen;
    const data = buf.slice(dataStart, dataStart + compSize);
    if (name === wantedName) {
      return method === 0 ? data : inflateRawSync(data);
    }
    offset = dataStart + compSize;
  }
  return null;
}

function docxToText(buf) {
  const xml = readZipEntry(buf, 'word/document.xml');
  if (!xml) throw new Error('不是有效的 .docx（缺少 word/document.xml）');
  let s = xml.toString('utf8');
  s = s.replace(/<\/w:p>/g, '\n');
  const texts = Array.from(s.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)).map((m) => m[1]);
  // 若没有 w:t（部分文档用其他标签），退化为去标签处理
  if (!texts.length) {
    texts.push(s.replace(/<[^>]+>/g, ' '));
  }
  return decodeEntities(texts.join(''))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function pdfToText(buf) {
  try {
    const mod = await import('pdf-parse');
    const fn = mod.default || mod;
    const out = await fn(buf);
    return String(out.text || '').trim();
  } catch (e) {
    throw new Error('PDF 解析需要安装可选依赖：npm i pdf-parse（或直接把作业存成 .txt / .docx 上传）');
  }
}

/**
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {Promise<{type:'text'|'image', text?:string, imageBase64?:string, mimeType?:string, reason?:string}>}
 */
export async function parseFile(buffer, filename) {
  const ext = extname(filename || '').toLowerCase();
  if (IMAGE_EXT.includes(ext)) {
    return {
      type: 'image',
      imageBase64: buffer.toString('base64'),
      mimeType: MIME[ext] || 'image/jpeg',
      reason: '交给多模态转录链路',
    };
  }
  if (ext === '.docx') return { type: 'text', text: docxToText(buffer) };
  if (ext === '.pdf') return { type: 'text', text: await pdfToText(buffer) };
  if (TEXT_EXT.includes(ext) || ext === '' || TEXT_EXT.length) return { type: 'text', text: buffer.toString('utf8').trim() };
  return { type: 'text', text: buffer.toString('utf8').trim() };
}

export const SUPPORTED = { TEXT_EXT, IMAGE_EXT, docx: true, pdf: '需可选依赖 pdf-parse' };
export { readZipEntry };
