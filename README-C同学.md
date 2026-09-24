# ClassPilot · C 同学（后端 & 材料）对接手册

> 2026-09-22 立。B 同学已把「文件解析 + 落库 + 成绩查询 + 教师复核」这条链路写好并跑通，你不用从零写，按本手册接手即可，重点在**换成真实文件来源**和**部署**。

---

## 1. 你现在手里已经有的东西

| 文件 | 作用 | 状态 |
|---|---|---|
| `lib/store/db.js` | SQLite 数据层，用 Node 内置 `node:sqlite`，**零第三方依赖**；不支持时自动降级 JSON 快照；自带增量字段迁移 | ✅ 已跑通 |
| `lib/store/repo.js` | 仓储层：作业 / 学生 / 提交 / 批改结果 / 教师复核 的存取，接口稳定；`saveSubmission` 已支持 `pageCount` 与 `transcript` | ✅ 已跑通 |
| `lib/store/bootstrap.js` | 初始化：把 3 次作业与 30 名学生写进库，幂等可重复执行 | ✅ 已跑通 |
| `lib/parse/file.js` | 文件 → 文本：txt/md/py/js 直读、**docx 零依赖解析**、pdf（需 `npm i pdf-parse`）、图片（交多模态） | ✅ 已跑通 |
| `lib/parse/multi.js` | **多文件/多页合并提取**：受控并发转录 → 按序合并 → 单页失败降级 warning | ✅ 已跑通 |
| `lib/parse/image.js` | 图片预处理：EXIF 自动转正 + 长边缩放 + 压缩（sharp 可选依赖，不可用时静默降级） | ✅ 已跑通 |
| `lib/util/mem.js` | 堆内存预检与快照（OOM 防线） | ✅ 已跑通 |
| `app/api/upload/route.js` | 上传接口：multipart（可重复 `file` 字段）或 base64 JSON（单文件 / `files[]` 多文件），自动解析 → 入库 → 批改 → 存结果 | ✅ 已写好 |
| `eval/smoke_db.mjs` | 你这条链路的自检脚本，**当前 10/10 PASS**（含多页合并、OOM 护栏） | ✅ 已跑通 |

自检：

```bash
node eval/smoke_db.mjs
# 数据初始化 → .py 解析 → .docx 解析 → 提交入库 → 批改结果入库 → 成绩查询 → 教师复核
```

---

## 2. 数据库表结构（已建好）

```sql
assignments       (id, course, title, type, description, rubric_json, created_at)
students          (id, name, class_id)
submissions       (id, assignment_id, student_id, source, filename, raw_text, page_count, transcript_json, created_at)
grading_results   (id, submission_id, assignment_id, student_id, total_score, result_json, mode, graded_at)
teacher_feedback  (id, submission_id, dimension, teacher_score, comment, created_at)
```

- `page_count` / `transcript_json` 是 9/22 晚新增列（多页拍照批改用）；`db.js` 启动时会自动 `ALTER TABLE` 迁移老库文件，**不用删库重建**
- 库文件：`data/classpilot.db`（已在 `.gitignore`？**请确认不要提交进 Git**，必要时把 `data/` 加进忽略）
- 演示期就用 SQLite 单文件，**不要碰 MySQL 运维**

---

## 3. 接口契约（前端 A 同学在等这两个）

### `POST /api/upload`
入参三选一：

```bash
# multipart 单文件（A 同学的表单直传）
curl -F "assignmentId=A1" -F "studentId=stu01" -F "file=@作业.pdf" http://localhost:3000/api/upload

# multipart 多文件（多页作业，file 字段可重复）
curl -F "assignmentId=A1" -F "file=@第1页.jpg" -F "file=@第2页.jpg" http://localhost:3000/api/upload

# 或 JSON base64（单文件 contentBase64 / 多文件 files[]）
curl -X POST http://localhost:3000/api/upload -H "Content-Type: application/json" \
  -d '{"assignmentId":"A1","studentId":"stu01","files":[{"filename":"p1.jpg","contentBase64":"..."},{"filename":"p2.jpg","contentBase64":"..."}]}'
```

返回（**字段已定死，改动必须群内同步**）：

```json
{
  "ok": true,
  "submissionId": "sub_111f8bbc",
  "resultId": "gr_f16910a8",
  "filename": "p1.jpg + p2.jpg",
  "source": "image",
  "charCount": 435,
  "preview": "解：设 Sn = ...",
  "transcript": "合并后的完整转录原文",
  "pages": [{"index":1,"filename":"p1.jpg","text":"...","elapsedMs":3200,"meta":{"engine":"sharp","savedPct":72}}],
  "warnings": [],
  "elapsedMs": 6100,
  "result": { "total_score": 69, "dimensions": [{"name":"...","score":22,"max":30,"evidence":"原文引用","confidence":"high"}], "comment": "..." }
}
```

`source` 取值：`file`（文档）/ `image`（纯拍照）/ `mixed`（图文混传）。`pages[].meta.savedPct` 是服务端压缩省掉的体积百分比，演示时可以当工程亮点讲。

### `GET /api/results?assignmentId=A1`
返回该次作业全部成绩行（含 `result` 已解析好的对象），学情看板直接取这个。

### `POST /api/grade/batch`（批量批改，9/22 晚新增）

```bash
# 启动：立刻返回 taskId，不阻塞
curl -X POST http://localhost:3000/api/grade/batch -H "Content-Type: application/json" -d '{"assignmentId":"A1","concurrency":3}'
# → {"ok":true,"taskId":"batch_13e690db","total":30,"concurrency":3}

# 查进度（前端每 300ms 轮询一次）
curl "http://localhost:3000/api/grade/batch?id=batch_13e690db"
# → task: {status:"running|done|cancelled|failed", done, ok, failed, progress, elapsedMs}
#   完成后 summary: {count, avg, median, highest, lowest, passRate, distribution[]}

# 取消
curl -X POST http://localhost:3000/api/grade/batch -H "Content-Type: application/json" -d '{"action":"cancel","id":"batch_13e690db"}'
```

- 结果**逐份落库**（`saveGradingResult`），中途崩了不丢已批的
- 顺序与花名册一致，单份失败重试 2 次且不中断整批
- 并发上限 8，默认 3（`GRADE_CONCURRENCY`）；真实模式下**别把并发开太大**，容易 429

### `POST /api/feedback`
`{submissionId, dimension, teacherScore, comment}` —— 教师改分写回，**人机协同闭环的落地点，答辩会被问到。」

---

## 4. 你需要做的三件事（按优先级）

1. **PDF 解析**：`npm i pdf-parse`，装完 `.pdf` 自动可用；装不上就让演示素材统一用 `.docx` / `.txt`
2. **批量上传**：写个脚本把 `demo data` 目录里 30 份作业一次性打到 `/api/upload`，学情看板才有数据
3. **部署**：腾讯云 CloudBase / CloudStudio（兜底 Vercel），**部署后务必重测一遍上传与批改**，环境变量只放 `HUNYUAN_API_KEY`

---

## 4.5 拍照上传（已支持，无需额外开发）

`lib/parse/multi.js`（多文件）/ `lib/parse/extract.js`（单文件兼容入口）已把图片链路封装好，upload 接口自动支持 jpg / png / webp / bmp：

```js
import { extractFromFiles } from '@/lib/parse/multi.js';
const extracted = await extractFromFiles([{ buffer, filename }, ...], { courseHint: '数学' });
// extracted = { source:'file'|'image'|'mixed', text, transcript, pages[], warnings[], mock, stats, elapsedMs }
```

- 有 Key → 调 `hunyuan-vision` 真识别；无 Key → MOCK 转录，链路照跑
- 多页自动合并（并发 2，页序稳定）；单页失败不拖垮整份，只有全部失败才抛错
- 服务端会用 sharp 做 EXIF 转正 + 压缩（long edge 1600px），前端不压缩也不会 OOM；sharp 不可用自动降级为原图直传
- 返回结果请把 `transcript` 原样给前端（老师要校对）；`source` 用于打「来自拍照」标签
- 单张超过 12MB 会被前置拦截并给友好报错；堆内存吃紧时直接提示「减少张数」而不是崩溃

**真实效果数据**：把手写照片 + 同名 `.txt` 标准答案放进 `eval/ocr/`，跑 `npm run eval:ocr`，得到 CER / 行命中率 / 批改要点召回率 / P95 延迟（详见 `eval/ocr/README.md`）。没有 Key 时脚本会明确标注 MOCK，**MOCK 数字不得写进文档**。

演示前请用真实手写照片替换 `eval/testset/demo-homework.png`（现在是程序生成的占位图），并在光线好的地方重拍 3–5 张**书写工整**的样本备用。

---

## 5. 红线

- `HUNYUAN_API_KEY` 只放环境变量，不进 Git（下次提交前各自查一遍）
- 学情统计与文档里的数字必须是**真实跑出来的**，不许手工美化
- 写代码只用 LearnBuddy（CodeBuddy），不用其他 AI 编程工具
