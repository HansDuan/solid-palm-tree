# ClassPilot 智课领航员 · B 同学交付包（2026-09-22 立）

> 从零开始，4 天（9/22 晚 – 9/25 晚）到 9/26 24:00 交卷。  
> 本目录是**已经跑通的骨架**：批改 pipeline + Prompt 体系 + Agent 工具 + 评测脚本 + 演示页面，全部可直接运行。



---

## 0. 技术选型（已定）

| 层           | 选型                                            | 理由                      |
| ----------- | --------------------------------------------- | ----------------------- |
| 开发语言        | JavaScript（Next.js 15 App Router，一体式）         | 一套语言一个仓库一次部署；4 天内沟通成本最低 |
| 批改 pipeline | `lib/grading/`，纯 JS 模块，可整体平移到 Python 服务       | 与前端解耦，你和 C 同学互不阻塞       |
| 模型          | **腾讯混元**（`hunyuan-turbos` / `hunyuan-vision`） | 合规唯一选项 + 腾讯生态叙事         |
| 演示兜底        | MOCK 模式（无 API Key 自动启用）                       | 今晚起全链路可演示，Key 到位即切真实链路  |
| 数据          | `lib/store/memory.js` 内存虚拟班级（30 人）            | C 同学接 SQLite 时只需替换本文件实现 |

---

## 1. 现在就能跑的三条命令

```bash
node demo/server.mjs        # 演示服务：打开 http://127.0.0.1:3111   ← 今晚先看这个
node eval/run_eval.mjs      # 效果评测：10 份样本 × 3 次，输出一致性/MAE/解析成功率/证据定位
node eval/smoke_tools.mjs   # 演示指令自检：5 条指令逐条 PASS/FAIL
node eval/smoke_db.mjs      # C 同学链路自检：10 项（含 docx 解析、拍照转录、多页合并、OOM 护栏）
node eval/smoke_batch.mjs   # 批量批改自检：30 份并发 + 顺序一致 + 逐份落库 + 取消，附耗时实测
npm run eval:ocr            # 手写照片转录评测：CER/行命中/要点召回 + 耗时（详见 eval/ocr/README.md）
npm run key -- <你的Key>     # 把混元 Key 写进 .env.local（自动格式校验，绝不进 Git）
```

已验证结果（MOCK 模式）：

- `eval` → JSON 解析成功率 **100%**、证据可定位率 **100%**、分数分布 51–84 有梯度
- `smoke_tools` → **5/5 PASS**（批改 / 学情 / 预警 / 练习 / 闲聊）
- `smoke_db` → **10/10 PASS**（含多页照片合并批改、>12MB 图片前置拦截）
- `smoke_batch` → **10/10 PASS**，30 份并发 3 共 **0.54s**（18ms/份），平均 68.5 分、及格率 60%、待复核维度 37 条
- 单份批改 < 0.1 秒（真实模式下取决于混元响应，需压到 30 秒内）

配套文档：**`DEMO-RUNBOOK.md`**（3 分钟演示时间轴 + 6 条指令话术 + 决赛 Q&A + 翻车预案）、**`DEPLOY.md`**（部署清单 + 环境变量 + 提交清单）。

> ⚠️ MOCK 模式的分数是规则模拟，**不能拿去做效果宣传**。拿到 Key 后重跑 `eval`，把真实指标填进 `prompts.md` 的版本记录里。

---

## 2. 目录说明

```
prompts.md              所有 Prompt 的唯一维护点（改了必须记版本）
lib/grading/llm.js      模型调用封装：有 Key 走混元，无 Key 走 MOCK
lib/grading/prompts.js  代码里的 Prompt 唯一来源（与 prompts.md 同步）
lib/grading/pipeline.js 批改主流程：rubric → 证据链评分 → 重试解析 → 一致性
lib/grading/parse.js    JSON 剥离 / 校验 / 重试 / 归一化
lib/store/memory.js     虚拟班级 30 人 + 4 个工具的本地实现
lib/agent/agent.js      Agent 调度：意图识别 → 工具调用 → 口语化总结
app/                    Next.js 页面与 API（正式版）
demo/                   零依赖演示服务与页面（兜底版，今晚用）
eval/                   测试集 samples.json + 评测脚本 + 自检脚本
```

---

## 2.5 C 同学那条线也已就绪（README-C同学.md）

文件解析 + 落库 + 成绩查询 + 教师复核，全部写好并自检通过（`node eval/smoke_db.mjs` → 7/7）：

- SQLite 用的是 Node 内置 `node:sqlite`，零第三方依赖；不支持时自动降级 JSON 快照
- `.docx` 做了零依赖解析（内置极简 ZIP + XML 提取），`.pdf` 需 `npm i pdf-parse`
- 上传链路：`POST /api/upload`（multipart 或 base64）→ 解析 → 入库 → 批改 → 存结果；`GET /api/results`；`POST /api/feedback`（教师改分写回）

### 批量批改（整个班一次批完，已通）

`POST /api/grade/batch {assignmentId, concurrency?}` → 立刻返回 `taskId`，**不阻塞**；
`GET /api/grade/batch?id=xxx` → 进度快照（done/ok/failed/耗时）；`?full=1` 含每份明细；不带 id 返回任务列表；
`POST /api/grade/batch {action:'cancel', id}` → 取消。

设计要点（都是踩过才加的）：

- **结果顺序 = 花名册顺序**。原来的 `gradeBatch` 是「谁先跑完谁先入列」，并发下顺序是乱的，老师要对着学号重排——已用「写回固定下标」修正。
- **单份失败自动重试 2 次**，仍失败只记该条失败原因，不中断整批。
- **逐份落库**，中途崩溃不丢已批的成绩。
- **可取消**，演示时要换作业能立刻停，不继续烧额度。

前端已带进度条 + 分布统计（平均/中位/最高/最低/及格率/待复核数/分段直方图）。

### 拍照上传（多模态 + 多页合并，已通）

同一个 `POST /api/upload` 接口：

- 传**单张**图片 → `hunyuan-vision` 转录 → 同一条证据链批改 → 入库
- 传**多张**（`files:[{filename, contentBase64}]` 或 multipart 重复 `file` 字段）→ 分页转录（并发 2）→ **合并成一份完整答案** → 再批改。一道大题写满两页不会被误判成「步骤不完整」

返回里会多几个字段：`source: "image|file|mixed"`、`transcript`（合并后原文）、`pages[]`（每页耗时/预处理压缩率/错误）、`warnings[]`（空白页、单页失败等）。前端把 transcript 放进可编辑框，让老师校对后再点「重新批改」——这就是我们答辩要讲的**降级方案**，也是人机协同的落点。

**稳定性设计（演示现场不翻车）**：

- 客户端：多选/连拍/拖拽，长边压到 1600px 白底 JPEG 再上传
- 服务端：sharp 自动 EXIF 转正 + 二次压缩（不可用时静默降级）；单张 ≤12MB 前置拦截；堆内存预检（超 90% 直接给「请减少张数」而不是 OOM 白屏）；视觉调用 120s 超时 + 5xx/429 退避重试；全部页失败才报错，单页失败降级成 warning
- 手写转录 Prompt v2：反脑补铁律（认不清 `[?]`、禁止替学生补步骤）+ 公式线性化 + 代码缩进保留

想单独验证识别效果（不批改）用 `POST /api/ocr`；`GET /api/health` 可看当前模式/内存/配置。

**效果数据怎么来**：`npm run eval:ocr` 跑 `eval/ocr/` 里的真实手写照片（放照片 + 同名 `.txt` 人工标准答案），产出 CER / 行命中率 / 批改要点召回率 / P95 延迟，报告写入 `eval/ocr-report.md`。没有真实照片前可先 `npm run ocr:samples` 生成合成样本验证管线（数字不可用于报告）。

演示拍摄建议：正上方拍、光线均匀、字迹占画面 2/3 以上。

## 3. 与队友的接口契约（今晚请同步给 A、C）

### 给 C 同学（后端）

| 接口           | 方法   | 入参                     | 返回                                    |
| ------------ | ---- | ---------------------- | ------------------------------------- |
| `/api/grade` | POST | `{assignmentId, text}` | `{ok, elapsedMs, assignment, result}` |

`result` 结构（**字段已定死，改了必须群内同步**）：

```json
{
  "total_score": 83,
  "dimensions": [
    {"name":"正确性","score":36,"max":40,"evidence":"学生原文引用≤60字","reason":"给分理由","confidence":"high|low"}
  ],
  "strengths": [], "improvements": [], "comment": "给学生看的评语",
  "rubric": {"dimensions":[...]}, "mode": "REAL|MOCK"
}
```

需要他提供的：

1. 文件上传解析接口 → 转成上面入参里的 `text`（PDF 用 pdf-parse / Python PyMuPDF）
2. 批改结果落表：`grading_results(assignment_id, student_id, result_json, graded_at)`
3. 部署环境的 `HUNYUAN_API_KEY` 注入（本地放到 `.env.local`，**绝不进 Git**）

### 给 A 同学（前端/产品）

- 批改接口约定 **30 秒内返回**，超时前端显示「AI 初审排队中」并轮询，绝不白屏
- `confidence: "low"` 的维度必须显示「待复核」角标（这是人机协同叙事的视觉落点）
- 演示 6 条指令的话术以 `eval/smoke_tools.mjs` 里的 COMMANDS 为准，D6 前锁死

---

## 4. 剩余 4 天重排（今天 9/22 晚起）

| 天              | 目标                                           | 验收标准                                      |
| -------------- | -------------------------------------------- | ----------------------------------------- |
| **D5 今晚 9/22** | 立骨架 + MOCK 全链路                               | `node demo/server.mjs` 打开就能批改出带证据的结果 ✅已完成 |
| **D6 9/23**    | ① 申请混元 Key，切真实链路跑通单份批改 ② C 接文件解析，A 接页面       | 真实模型批改 1 份作业成功，JSON 解析成功率 ≥95%            |
| **D7 9/24**    | ① 30 份批量批改 + 失败重试 ② Agent 4 工具全通 ③ 多模态手写照片转录 | `eval` 真实模式跑出指标；`smoke_tools` 6/6 PASS    |
| **D8 9/25**    | ① prompt 调优到 MAE ≤8 ② 部署 + 演示视频素材 ③ 整理开发过程截图 | 提交清单逐项打勾；**提前 ≥24h 提交**                   |
| 9/26           | 只作缓冲，不安排新任务                                  | 12:00 前定版                                 |

**今晚你自己的 3 件事**：① 把仓库推到 Git 并拉 A、C 进群；② 申请混元 API Key（腾讯云控制台）；③ 用 `demo/server.mjs` 给队友演示一次闭环。

---

## 5. 合规红线（比赛硬性）

1. **写代码只用 LearnBuddy（CodeBuddy）**，不用 Cursor / Copilot / 其他 AI，也不把代码贴到别的聊天 AI 里改
2. **产品内 AI 只用腾讯混元**，不接 DeepSeek / GLM / Qwen 等第三方模型
3. API Key 不进 Git（`.gitignore` 已配 `.env.local`）
4. 文档与答辩数据必须真实，MOCK 分数不得当作评测数据展示
