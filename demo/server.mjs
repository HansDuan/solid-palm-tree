/**
 * 零依赖演示服务器（今晚就能给评委/队友看效果的兜底方案）
 * 使用：node demo/server.mjs  然后打开 http://127.0.0.1:3111
 * 说明：Next.js 版可用后本文件即可弃用；两者共用同一套 lib/ 代码，行为一致。
 */
import '../lib/env.js'; // 必须在最前：把 .env.local 的 Key/端点读进 process.env，否则真实模型链路会掉进 MOCK
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeAssignment } from '../lib/grading/pipeline.js';
import { gradeChoiceBatch } from '../lib/grading/choice-batch.js';
import { startBatch, getBatch, listBatches, cancelBatch, batchSummaryById } from '../lib/grading/batch.js';
import { listAssignments, getSubmissions, setAnswerKey, addAssignment, tool_get_class_report, tool_scan_plagiarism } from '../lib/store/memory.js';
import { runAgent } from '../lib/agent/agent.js';
import { extractFromFiles, MAX_PAGES } from '../lib/parse/multi.js';
import { seed } from '../lib/store/bootstrap.js';
import { getDb, storageMode } from '../lib/store/db.js';
import { heapSnapshot } from '../lib/util/mem.js';
import { runtimeConfig, chat, isMock } from '../lib/grading/llm.js';
import { dimensionAverages, parseResult, buildWeeklyReportText, buildExerciseText } from '../lib/analytics.js';
import {
  saveSubmission,
  saveGradingResult,
  listResults,
  saveTeacherFeedback,
  listFeedback,
} from '../lib/store/repo.js';

seed(); // 启动时自动建库并写入作业/学生

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 3111;

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function body(req) {
  return new Promise((ok) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try {
        ok(JSON.parse(s || '{}'));
      } catch {
        ok({});
      }
    });
  });
}

/**
 * 单份「异步批改」任务表：jobId → { status: running|done|error, ... }
 * 存在的理由：hy3 + v4 prompt 批改一份主观题要 45~130s，
 * 免费隧道（≈120s 请求上限）和浏览器都会在同步等待中被掐断。
 * 改成「提交拿 jobId → 前端轮询」，任一环节都不会因为耗时而失败。
 */
const singleJobs = new Map();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(resolve(root, 'demo/index.html'), 'utf8'));
    } else if (url.pathname === '/globals.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(readFileSync(resolve(root, 'app/globals.css'), 'utf8'));
    } else if (url.pathname === '/api/grade' && req.method === 'GET') {
      json(res, { assignments: listAssignments() });
    } else if (url.pathname === '/api/grade' && req.method === 'POST') {
      const { text, assignmentId = 'A1' } = await body(req);
      const assignment = listAssignments().find((a) => a.id === assignmentId) || listAssignments()[0];
      const t0 = Date.now();
      const result = await gradeAssignment({ assignment, studentText: text });
      json(res, { ok: true, elapsedMs: Date.now() - t0, assignment, result });
    } else if (url.pathname === '/api/grade/async' && req.method === 'POST') {
      // 提交一份批改任务，立刻返回 jobId（不等模型），由前端轮询取结果
      const { text, assignmentId = 'A1' } = await body(req);
      const assignment = listAssignments().find((a) => a.id === assignmentId) || listAssignments()[0];
      const id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      singleJobs.set(id, { id, status: 'running', startedAt: Date.now() });
      (async () => {
        const t0 = Date.now();
        try {
          const result = await gradeAssignment({ assignment, studentText: text });
          singleJobs.set(id, { id, status: 'done', startedAt: t0, elapsedMs: Date.now() - t0, assignment, result });
        } catch (e) {
          singleJobs.set(id, { id, status: 'error', startedAt: t0, elapsedMs: Date.now() - t0, error: e.message || String(e) });
        }
      })();
      json(res, { ok: true, jobId: id });
    } else if (url.pathname === '/api/grade/async' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      const job = id ? singleJobs.get(id) : null;
      if (!job) return json(res, { ok: false, error: '任务不存在或已过期' }, 404);
      json(res, {
        ok: true,
        id: job.id,
        status: job.status,
        elapsedMs: job.elapsedMs ?? Date.now() - job.startedAt,
        assignment: job.assignment,
        result: job.result,
        error: job.error,
      });
    } else if (url.pathname === '/api/grade/batch' && req.method === 'POST') {
      const b = await body(req);
      if (b.action === 'cancel') {
        const t = cancelBatch(b.id);
        return json(res, t ? { ok: true, task: t } : { ok: false, error: '任务不存在' }, t ? 200 : 404);
      }
      const assignmentId = b.assignmentId || listAssignments()[0]?.id;
      const assignment = listAssignments().find((a) => a.id === assignmentId) || listAssignments()[0];
      const rows = getSubmissions(assignmentId);
      const submissions = (b.limit ? rows.slice(0, b.limit) : rows).map((s) => ({
        studentId: s.studentId || s.id,
        studentName: s.studentName || s.name,
        text: s.text,
      }));
      if (!submissions.length) return json(res, { ok: false, error: `作业 ${assignmentId} 没有可批改的提交` }, 400);
      const task = startBatch({ assignment, submissions, concurrency: b.concurrency });
      json(res, { ok: true, taskId: task.id, total: task.total, concurrency: task.concurrency, assignment });
    } else if (url.pathname === '/api/grade/batch' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id) return json(res, { ok: true, tasks: listBatches() });
      const t = getBatch(id, { withResults: url.searchParams.get('full') === '1' });
      if (!t) return json(res, { ok: false, error: '任务不存在' }, 404);
      json(res, {
        ok: true,
        task: t,
        summary: t.status === 'done' || t.status === 'cancelled' ? batchSummaryById(id) : null,
      });
    } else if (url.pathname === '/api/agent' && req.method === 'POST') {
      const { message } = await body(req);
      const out = await runAgent(message);
      json(res, { ok: true, ...out });
    } else if (url.pathname === '/api/assignments' && req.method === 'GET') {
      json(res, { ok: true, assignments: listAssignments() });
    } else if (url.pathname === '/api/assignments' && req.method === 'POST') {
      const b = await body(req);
      try {
        const a = addAssignment(b);
        json(res, { ok: true, assignment: a });
      } catch (e) {
        json(res, { ok: false, error: e.message }, 400);
      }
    } else if (url.pathname === '/api/dashboard' && req.method === 'GET') {
      // 学情看板：复用既有班级报告工具（C 同学接入真实库后可原地替换实现）
      const assignmentId = url.searchParams.get('assignmentId') || listAssignments()[0]?.id;
      const report = await tool_get_class_report({ assignmentId });
      /* C 同学 2026-09-25 兼容层：把后端字段对齐前端看板（src/views/Dashboard.vue）
         - distribution: analytics 输出 {bucket,count}，前端读 x.range → 补 range
         - errored / erroredNames / lowConfidenceNames：前端预警名单需要
         - submissionCount：提交总数（含未批改） */
      let submissionCount = 0;
      let errored = 0;
      const erroredNames = [];
      try {
        const db2 = getDb();
        if (db2) {
          const subs = db2.all('SELECT id, student_id, raw_text FROM submissions WHERE assignment_id = ?', [assignmentId]);
          submissionCount = subs.length;
          // C 修复 2026-09-25：批量批改落库的 submission_id 是 batch:xxx 合成号，
          // 与 submissions.id 对不上 → 按 student_id 对账（batch.js 落库时 student_id 是真实 ID），只认 REAL
          const done = new Set(
            db2.all("SELECT student_id FROM grading_results WHERE assignment_id = ? AND mode = 'REAL'", [assignmentId]).map((r) => r.student_id)
          );
          const names2 = new Map(db2.all('SELECT id, name FROM students').map((r) => [r.id, r.name]));
          for (const s of subs) {
            if (!done.has(s.student_id)) { errored++; erroredNames.push(names2.get(s.student_id) || s.student_id); }
          }
        }
      } catch { /* 仓储不可用时忽略，字段保持默认 */ }
      const lowConfidenceNames = (report.results || [])
        .filter((r) => (r.dimensions || []).some((d) => d.confidence === 'low'))
        .map((r) => r.name);
      json(res, {
        ok: true,
        ...report,
        patch: 'c-2026-09-25-errored-fix', // 版本指纹：出现此字段 = 新代码在跑
        distribution: (report.distribution || []).map((x) => ({ ...x, range: x.range || x.bucket || '' })),
        // C 补 2026-09-25：前端雷达图（Dashboard.vue）读 x.name / x.max / x.avg，B 的报告输出字段名是 dimension
        dimensions: (report.dimensions || []).map((x) => ({ ...x, name: x.name || x.dimension })),
        submissionCount,
        errored, // 新代码：以本地按 student_id 对账的结果为准（B 的 report 无此字段，原优先级写法易踩坑）
        erroredNames, // 同上
        lowConfidenceNames: report.lowConfidenceNames || lowConfidenceNames,
      });
    } else if (url.pathname === '/api/plagiarism' && req.method === 'GET') {
      // 查重：C 同学的 TF-IDF + 余弦（analytics.js，纯函数、自检 14/14）——已接入真库
      const assignmentId = url.searchParams.get('assignmentId') || listAssignments()[0]?.id;
      const threshold = Number(url.searchParams.get('threshold')) || 0.5;
      const scan = await tool_scan_plagiarism({ assignmentId, threshold });
      json(res, { ok: true, ...scan });
    } else if (url.pathname === '/api/report/weekly' && req.method === 'POST') {
      // 班级周报（C 学情模块并入）：有 Key 模型润色，无 Key/失败自动降级本地模板（演示不断流）
      const { assignmentId } = await body(req);
      if (!assignmentId) return json(res, { ok: false, error: 'assignmentId 必填' }, 400);
      try {
        const db = getDb();
        const assignment = db.get('SELECT id, title, course FROM assignments WHERE id = ?', [assignmentId]);
        const subs = db.all('SELECT id FROM submissions WHERE assignment_id = ?', [assignmentId]);
        const grades = db.all('SELECT total_score, result_json FROM grading_results WHERE assignment_id = ? AND mode = ?', [assignmentId, 'REAL']);
        const parsed = grades.map((g) => parseResult(g.result_json));
        const stats = {
          assignmentId,
          course: (assignment && assignment.course) || '',
          assignmentTitle: (assignment && assignment.title) || '',
          submissionCount: subs.length,
          gradedCount: grades.length,
          dimensionAverages: dimensionAverages(parsed),
        };
        if (!stats.gradedCount) {
          return json(res, { ok: true, summary: '暂无批改数据，无法生成周报。', stats });
        }
        const system = '你是班主任助手，基于批改统计数据写班级周报。先列数字，再给洞察，150字内，禁止编造数据。';
        const user = `课程：${stats.course}；作业：${stats.assignmentTitle}；提交${stats.submissionCount}份，已批改${stats.gradedCount}份。各维度均值：${JSON.stringify(stats.dimensionAverages)}。请给出本周总结。`;
        let polished = '';
        if (!isMock()) {
          try { polished = await chat({ system, user, expectJson: false }); } catch { polished = ''; }
        }
        const clean = polished && polished.trim() && polished.trim() !== '{}' ? polished : '';
        const summary = clean || buildWeeklyReportText(stats);
        json(res, { ok: true, summary, polished: Boolean(clean), stats });
      } catch (e) {
        json(res, { ok: false, error: String((e && e.message) || e) }, 500);
      }
    } else if (url.pathname === '/api/exercises' && req.method === 'POST') {
      // 个性化练习（C 学情模块并入）：有 Key 模型出题，无 Key/失败降级模板占位
      const { weakPoints } = await body(req);
      const list = Array.isArray(weakPoints) ? weakPoints.filter(Boolean) : [];
      if (!list.length) return json(res, { ok: false, error: 'weakPoints 必须是非空数组' }, 400);
      const items = [];
      for (const kp of list) {
        let content = '';
        if (!isMock()) {
          try {
            content = await chat({
              system: '你是题库助手，针对薄弱知识点出 1 道练习题并给出答案。题目具体、可判，不超过 150 字。',
              user: `知识点：${kp}。请出一道练习题（含题干与答案）。`,
              expectJson: false,
            });
          } catch { content = ''; }
        }
        const clean = content && content.trim() && content.trim() !== '{}' ? content : '';
        items.push({ knowledgePoint: kp, question: clean || buildExerciseText(kp), polished: Boolean(clean) });
      }
      json(res, { ok: true, items });
    } else if (url.pathname === '/api/upload' && req.method === 'POST') {
      // 支持单文件 JSON 与多文件 { files:[{filename, contentBase64}] }
      const b = await body(req);
      const assignmentId = b.assignmentId || 'A1';
      const studentId = b.studentId || 'stu01';
      const studentName = b.studentName || '';
      const strip = (s) => String(s || '').split(',').pop() || '';
      const entries = Array.isArray(b.files) && b.files.length
        ? b.files.map((f) => ({ filename: f.filename || 'photo.jpg', buffer: Buffer.from(strip(f.contentBase64), 'base64') }))
        : [{ filename: b.filename || '作业.txt', buffer: Buffer.from(strip(b.contentBase64), 'base64') }];
      const kept = entries.filter((e) => e.buffer.length);
      if (!kept.length) return json(res, { ok: false, error: '文件内容为空，请重新选择' }, 400);

      const extracted = await extractFromFiles(kept, { courseHint: b.courseHint });
      const text = extracted.text || '';
      if (!text.trim()) {
        return json(
          res,
          {
            ok: false,
            error: '未能识别出内容，请重拍一张（正上方俯拍、光线均匀、字迹占画面 2/3 以上）',
            warnings: extracted.warnings,
            pages: extracted.pages.map((p) => ({ index: p.index, filename: p.filename, ok: !p.error, error: p.error })),
          },
          422
        );
      }
      const sub = saveSubmission({
        assignmentId,
        studentId,
        studentName,
        text,
        filename: kept.map((e) => e.filename).join(' + '),
        source: extracted.source, // file | image | mixed
        pageCount: kept.length,
        transcript: extracted.transcript,
      });
      const assignment = listAssignments().find((a) => a.id === assignmentId) || listAssignments()[0];
      const result = await gradeAssignment({ assignment, studentText: text });
      const resultId = saveGradingResult({ submissionId: sub.id, assignmentId, studentId, result });
      json(res, {
        ok: true,
        submissionId: sub.id,
        resultId,
        source: extracted.source,
        mockTranscript: extracted.mock === true,
        transcript: extracted.transcript,
        charCount: text.length,
        preview: text.slice(0, 200),
        pages: extracted.pages,
        warnings: extracted.warnings,
        elapsedMs: extracted.elapsedMs,
        result,
      });
    } else if (url.pathname === '/api/results') {
      json(res, { ok: true, storage: storageMode(), results: listResults(url.searchParams.get('assignmentId') || 'A1') });
    } else if (url.pathname === '/api/ocr' && req.method === 'POST') {
      // 只做多图转文字，不批改 —— 调 Key / 验收识别效果时用这个
      const b = await body(req);
      const strip = (s) => String(s || '').split(',').pop() || '';
      const entries = Array.isArray(b.files) && b.files.length
        ? b.files.map((f) => ({ filename: f.filename || 'photo.jpg', buffer: Buffer.from(strip(f.contentBase64), 'base64') }))
        : [{ filename: b.filename || 'photo.jpg', buffer: Buffer.from(strip(b.contentBase64), 'base64') }];
      if (!entries.some((e) => e.buffer.length)) return json(res, { ok: false, error: '图片内容为空' }, 400);
      const ex = await extractFromFiles(entries.filter((e) => e.buffer.length), { courseHint: b.courseHint });
      json(res, {
        ok: true,
        source: ex.source,
        mock: ex.mock,
        transcript: ex.transcript,
        text: ex.text,
        pages: ex.pages,
        warnings: ex.warnings,
        stats: ex.stats,
        elapsedMs: ex.elapsedMs,
      });
    } else if (url.pathname === '/api/health') {
      json(res, { ok: true, mode: runtimeConfig(), memory: heapSnapshot(), maxPages: MAX_PAGES, storage: storageMode() });
    } else if (url.pathname === '/api/feedback' && req.method === 'POST') {
      const { submissionId, dimension, teacherScore, comment } = await body(req);
      const id = saveTeacherFeedback({ submissionId, dimension, teacherScore, comment });
      json(res, { ok: true, id, feedback: listFeedback(submissionId) });
    } else if (url.pathname === '/api/mode') {
      // C 补 2026-09-25：前端 ModeBadge.vue 要求 res.ok 为真才采纳 mode，原响应缺 ok → 徽标一直误判 MOCK
      json(res, { ok: true, mode: process.env.HUNYUAN_API_KEY ? 'REAL' : 'MOCK', storage: storageMode() });
    } else if (url.pathname === '/api/answerkey' && req.method === 'POST') {
      // 教师上传标准答案（答案键）：文本直接存，图片先转录再存
      const b = await body(req);
      const assignmentId = b.assignmentId || listAssignments()[0]?.id;
      const assignment = listAssignments().find((a) => a.id === assignmentId) || listAssignments()[0];
      let keyText = String(b.text || '').trim();
      let source = 'text';
      if (!keyText && Array.isArray(b.files) && b.files.length) {
        const strip = (s) => String(s || '').split(',').pop() || '';
        const entries = b.files.map((f) => ({ filename: f.filename || 'key.jpg', buffer: Buffer.from(strip(f.contentBase64), 'base64') }));
        if (entries.some((e) => e.buffer.length)) {
          const ex = await extractFromFiles(entries.filter((e) => e.buffer.length), { courseHint: '标准答案' });
          keyText = (ex.text || '').trim();
          source = 'image';
        }
      }
      if (!keyText) return json(res, { ok: false, error: '标准答案不能为空：请粘贴文本，或上传写了答案的照片' }, 400);
      const keyObj = { type: assignment.type, text: keyText, source, savedAt: new Date().toISOString() };
      setAnswerKey(assignmentId, keyObj);
      json(res, {
        ok: true,
        assignmentId,
        type: assignment.type,
        keyMode: assignment.type === 'choice' || assignment.type === 'fill' || assignment.type === 'calc' ? 'exact' : 'solution',
        source,
        preview: keyText.slice(0, 200),
        charCount: keyText.length,
        message: '标准答案已保存，之后该作业的批改都会对照此答案键进行。',
      });
    } else if (url.pathname === '/api/grade/choice-batch' && req.method === 'POST') {
      // 选择题批量批改：标准答案键 + 一批学生答案 → 逐题比对出每人得分与班级正确率（纯规则，无需模型）
      const b = await body(req);
      const assignmentId = b.assignmentId || null;
      const assignment = assignmentId ? listAssignments().find((a) => a.id === assignmentId) : null;

      // 1) 解析答案键文本：优先用传入 key，其次图片转录，再次用作业自带答案键
      let keyText = String(b.key || '').trim();
      if (!keyText && Array.isArray(b.keyFiles) && b.keyFiles.length) {
        const strip = (s) => String(s || '').split(',').pop() || '';
        const entries = b.keyFiles.map((f) => ({ filename: f.filename || 'key.jpg', buffer: Buffer.from(strip(f.contentBase64), 'base64') }));
        if (entries.some((e) => e.buffer.length)) {
          const ex = await extractFromFiles(entries.filter((e) => e.buffer.length), { courseHint: '选择题标准答案' });
          keyText = (ex.text || '').trim();
        }
      }
      if (!keyText && assignment?.answerKey?.text) keyText = String(assignment.answerKey.text).trim();
      if (!keyText) return json(res, { ok: false, error: '缺少标准答案：请粘贴答案键（如 1.B 2.C 3.A 4.B），或上传写了答案的照片/选带答案键的作业' }, 400);

      // 2) 解析学生答案：多行文本，或上传一个 txt/csv（每行一个学生）
      let submissionsText = String(b.submissionsText || '').trim();
      if (!submissionsText && Array.isArray(b.submissionFiles) && b.submissionFiles.length) {
        const strip = (s) => String(s || '').split(',').pop() || '';
        const buf = Buffer.from(strip(b.submissionFiles[0].contentBase64), 'base64');
        submissionsText = buf.toString('utf8').trim();
      }
      const submissions = submissionsText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((text) => ({ text }));
      if (!submissions.length) return json(res, { ok: false, error: '没有可批改的学生答案：请在文本框每行粘贴一名学生的答案' }, 400);

      const totalPoints = Number(b.totalPoints) > 0 ? Number(b.totalPoints) : 100;
      const out = gradeChoiceBatch({ keyText, submissions, totalPoints });
      json(res, {
        ok: true,
        assignmentId: assignmentId || null,
        key: out.key,
        nQuestions: out.nQuestions,
        perQuestionPoints: out.perQuestionPoints,
        totalPoints: out.totalPoints,
        count: out.count,
        avg: out.avg,
        highest: out.highest,
        lowest: out.lowest,
        passRate: out.passRate,
        questionStats: out.questionStats,
        results: out.results,
      });
    } else {
      json(res, { error: 'not found' }, 404);
    }
  } catch (e) {
    json(res, { ok: false, error: String(e.message || e) }, 500);
  }
});

server.listen(PORT, () => console.log(`ClassPilot 演示服务已启动: http://127.0.0.1:${PORT}`));
