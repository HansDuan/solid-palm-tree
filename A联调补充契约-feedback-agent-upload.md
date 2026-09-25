# A 联调补充契约 · feedback / agent data / upload result（9/25）

> 应 A 侧 AI 提出的 4 项缺口逐条补齐。所有 JSON 均为**从代码与种子库实际抓取的真实结构**，非手写臆造。
> 源码包见 `classpilot-源码包-给A-20260925.zip`（含 `data/classpilot.db` 种子库 + 全部文档）。

---

## 0. 先泼一盆冷水：别按旧契约的 `teacher_note` 开发

旧契约写的 "teacher_score、teacher_note" 与实际代码**不一致**——实际字段是 `comment`，没有 `teacher_note`。以后端实际返回为准，本文档即实际返回。

---

## 1. `POST /api/feedback`（教师改分写回，已验证代码 `demo/server.mjs` + `lib/store/repo.js`）

**请求体**（`submissionId` 必填，其余可选但至少传一个，否则该条反馈为空记录）：
```json
{ "submissionId": "sub_stu01", "dimension": "正确性", "teacherScore": 35, "comment": "边界条件漏了空数组" }
```
- `dimension`：要改分的维度名（与批改结果 `dimensions[].name` 对应，如 "正确性"）
- `teacherScore`：教师改后的分数（整数）
- `comment`：教师评语（**注意：叫 `comment`，不是 `teacher_note`**）

**返回体**（保存成功后**直接回带该提交的全部反馈列表**，可立即用于渲染）：
```json
{
  "ok": true,
  "id": "fb_3a7c21de",
  "feedback": [
    { "id": "fb_3a7c21de", "submission_id": "sub_stu01", "dimension": "正确性",
      "teacher_score": 35, "comment": "边界条件漏了空数组", "created_at": "2026-09-25T13:20:00.000Z" }
  ]
}
```

**「已复核」怎么回显（A 关心的重点）**：
- 判定规则建议：`feedback` 列表中存在 `dimension === 某维度名 && teacher_score != null` 的记录 ⇒ 该维度"已复核"（教师分覆盖模型分显示）；有 `comment` ⇒ 显示评语角标。
- **刷新后要恢复"已复核"状态**：新增了查询接口（今天刚加，源码包里可能没有——用本文档为准）：

## 2. `GET /api/feedback?submissionId=…`（新增，9/25）

```
GET /api/feedback?submissionId=sub_stu01
→ { "ok": true, "submissionId": "sub_stu01", "feedback": [ 同上结构 ] }
```
无反馈时 `feedback: []`。页面加载时先 GET 一次即可恢复已复核标记。

---

## 3. `/api/agent` 四种 tool 的 `data` 真实样例

外层统一为 `{ ok, tool, data, reply }`；`reply` 是模型口语化总结（MOCK 时为模板文本）。以下 `data` 均为实际运行抓取。

### 3.1 `tool = grade_assignment`
```json
{
  "assignmentId": "A1", "count": 30,
  "results": [
    { "studentId": "stu01", "name": "陈家豪", "total_score": 80,
      "dimensions": [
        { "name": "正确性", "score": 31, "max": 40, "evidence": "def solution(arr, target):", "reason": "命中参考解要点", "confidence": "high" },
        { "name": "算法与复杂度", "score": 17, "max": 20, "confidence": "high" }
      ],
      "key_match": "full", "keyMode": "solution", "mode": "REAL",
      "strengths": ["…"], "improvements": ["…"], "comment": "…", "usedAnswerKey": true }
  ]
}
```
⚠️ 渲染悬浮球卡片时注意容错：**单份批改失败的条目是 `{ studentId, name, error }`（无 `total_score`/`dimensions`）**，必须判空跳过，不要假设人人都有分。`results` 全量 30 条，卡片建议只取前 5~10 条（后端给模型总结时也是截前 10）。

### 3.2 `tool = get_class_report`（有数据分支；样例取自种子库 A3 的 **7 条 REAL 真实批改**）
```json
{
  "assignmentId": "A3", "realCount": 7, "avg": 74,
  "highest": 93, "lowest": 48,
  "distribution": [ { "bucket": "0-59", "count": 1 }, { "bucket": "60-69", "count": 1 },
                    { "bucket": "70-79", "count": 2 }, { "bucket": "80-89", "count": 2 }, { "bucket": "90-100", "count": 1 } ],
  "dimensions": [ { "dimension": "关键步骤完整性", "avg": 26.9, "max": 30 },
                  { "dimension": "方法正确性", "avg": 11.4, "max": 30 },
                  { "dimension": "计算准确性", "avg": 20, "max": 20 },
                  { "dimension": "书写与解释", "avg": 15.6, "max": 20 } ],
  "lowConfidence": 1,
  "results": [ { "studentId": "stu01", "name": "陈家豪", "total_score": 74,
                 "dimensions": [ { "name": "关键步骤完整性", "score": 28, "max": 30 } ] } ]
}
```
⚠️ **空数据分支**（该作业还没有 REAL 批改时，前端必须处理）：
```json
{ "assignmentId": "A1", "realCount": 0, "note": "尚无真实批改数据：请先运行真实批改…",
  "avg": 0, "highest": 0, "lowest": 0, "distribution": [ …全 0 ], "dimensions": [], "results": [] }
```
用 `realCount === 0` 判断，显示"暂无真实批改数据"引导页，**绝不要把 0 当真实均分渲染**。

### 3.3 `tool = generate_warning_list`
```json
{
  "students": [
    { "studentId": "stu03", "name": "王梓涵", "score": 50, "prev": 56, "drop": 6, "level": "高" }
  ],
  "total": 14
}
```
`level` ∈ `"高" | "中"`（`score<60` → 高；`drop>=8` → 中；"低"已被过滤）。排序：按 `drop` 降序。卡片渲染"退步幅度 + 预警等级"。

### 3.4 `tool = generate_practice`
```json
{
  "assignmentId": "A1",
  "practices": [
    { "studentId": "stu01", "name": "王梓涵", "score": 45,
      "weakPoint": "可读性",
      "items": [ "重命名含糊变量（如 a、tmp），统一缩进为 4 空格",
                 "将超过 30 行的函数拆分为两个职责单一的函数" ] }
  ]
}
```
固定取**最弱 5 人**（按总分升序），每人挂其最弱维度的 2 条练习。前端按 `practices[].name` 分卡片即可。

---

## 4. `/api/upload` 的 `result` 字段确认

**结论：与 `/api/grade/async` 完成态的 `result` 同构**——都出自同一个 `gradeAssignment({assignment, studentText})`，字段为：
```json
{ "total_score": 80, "dimensions": [ { "name", "score", "max", "confidence" } ],
  "summary": "…", "suggestion": "…" }
```
前端**一套解析即可**，不用做两套。`/api/upload` 完整返回：
```json
{ "ok": true, "submissionId": "…", "resultId": "…", "source": "image|file|mixed",
  "mockTranscript": false, "transcript": "OCR 转写全文", "charCount": 123,
  "preview": "前200字", "pages": [ { "index": 0, "filename": "photo.jpg", "ok": true } ],
  "warnings": [], "elapsedMs": 3200, "result": { …同上 } }
```
两个必须处理的失败态：
- **422**：`{ ok:false, error:"未能识别出内容，请重拍一张（正上方俯拍…）", warnings, pages }` —— OCR 没认出字，引导重拍；
- **超时**：upload 是**同步**接口（OCR+批改一口气），走隧道/弱网时可能超时。**拍照批改的正式联调建议走 `/api/ocr` → `POST /api/grade/async` → 轮询** 的异步组合（`/api/ocr` 返回的 `transcript` 直接作为 `grade/async` 的 `text`），upload 留给本地/局域网快路径。

---

## 5. 本次顺带修复（A 联调前请拉最新源码包）

- **`tool_grade_assignment` 的 `studentId` bug 已修**（`s.id` → `s.studentId`）：修复前预警名单/批量批改结果里没有 `studentId`、REAL 结果落库 `student_id=NULL`。A 渲染卡片列表的 `key` 请用 `studentId`。
- **新增 `GET /api/feedback`**（见 §2）。
- 契约文档 §2.2 已同步补 feedback 双接口条目。
