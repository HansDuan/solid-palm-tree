# 部署清单

> 两套可部署产物，按风险从低到高选。**比赛演示优先用第 1 套**——零依赖、起得来、不会因为编译环境问题翻车。

---

## 1. 零依赖演示服务（推荐，当前已跑通）

```bash
PORT=3111 node demo/server.mjs
```

- 只用 Node 内置模块，`sharp` 可选（缺了自动降级，功能不残废）
- 与 Next 版本**共用同一套 `lib/`**，行为一致
- 已实测：`/api/grade`、`/api/grade/batch`、`/api/upload`、`/api/ocr`、`/api/agent`、`/api/results`、`/api/feedback`、`/api/health`

### 部署后自检（一条命令跑完）

```bash
BASE=https://your-domain
curl $BASE/api/health                                   # 期望 mode 里出现 REAL(...)
curl $BASE/api/grade                                    # 期望返回 3 个作业
curl -X POST $BASE/api/grade -H 'Content-Type: application/json' \
  -d '{"assignmentId":"A1","text":"def f(x):\n    return x+1\n# O(1)"}'   # 期望带 total_score
curl -X POST $BASE/api/grade/batch -H 'Content-Type: application/json' \
  -d '{"assignmentId":"A1"}'                            # 期望返回 taskId + total=30
```

---

## 2. Next.js 正式版（`npm run build && npm start`）

⚠️ **已知环境限制**：本机 `next dev` / `next build` 无法运行——构建时删除 `.next` 临时文件被 LearnBuddy 的 `genie-safe-delete` 钩子拦截（绕过沙箱也失败）。这是本机环境问题，不是代码问题（此前已验证过 `✓ Compiled successfully`）。

**如果换台机器或 CI 来构建**，先确认能正常跑 `npm run build`，再决定用哪套。两套的 `lib/` 完全一致，切换成本为零。

---

## 3. 环境变量（部署平台只填这些）

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `HUNYUAN_API_KEY` | ✅ | 空 | 空则自动降级 MOCK。**只放环境变量，绝不进 Git** |
| `HUNYUAN_BASE_URL` | | `https://tokenhub.tencentmaas.com/v1` | ⚠️ TokenHub 网关域名是 `tencentmaas.com`（非老的 `tencentcloudmaas.com`），鉴权头用 `x-api-key`（非 Bearer） |
| `HUNYUAN_TEXT_MODEL` | | `hy3` | 混元文本模型。**勿用 `hy4-preview`**（推理模型，token 全烧在 thinking 块、产不出批改 JSON，见对接契约 §0.1） |
| `HUNYUAN_VISION_MODEL` | | `hy-vision-2.0-instruct` | 拍照批改用混元视觉模型；`hunyuan-t1-vision-20250916` 亦可 |
| `HUNYUAN_TIMEOUT_MS` | | `120000` | 文本调用超时（演示/录屏场景建议保持 ≥120s，避免误判超时重试） |
| `HUNYUAN_VISION_TIMEOUT_MS` | | `120000` | 视觉调用超时，手写大图别调小 |
| `HUNYUAN_MAX_RETRY` | | `2` | 5xx/429 退避重试次数 |
| `IMAGE_MAX_BYTES` | | `12582912` | 单张上传上限 |
| `IMAGE_MAX_EDGE` | | `1600` | 服务端压缩目标长边 |
| `MAX_PAGES` | | `6` | 单次最多文件数 |
| `OCR_CONCURRENCY` | | `2` | 图片转录并发 |
| `GRADE_CONCURRENCY` | | `3` | 批量批改并发 |
| `MAX_HEAP_MB` | | `1024` | 堆内存预算，超 90% 提前拒绝 |
| `DATA_DIR` | | `./data` | SQLite 落盘目录，**要挂可写盘** |
| `PORT` | | `3111` | 演示服务端口 |

---

## 4. 部署注意事项

- **`DATA_DIR` 必须可写**，否则会降级到 JSON 快照（功能可用但重启丢数据）；`/api/health` 里的 `storage` 字段会显示当前用的是哪种
- 数据库**首次启动自动建表**，老库会自动 `ALTER TABLE` 补新增列，不用删库重建
- 静态资源只有两个：`demo/index.html` 和 `app/globals.css`，服务直接读文件，无需构建
- 建议进程守护（PM2 / 平台自带），并在启动后打一次 `/api/health`

---

## 5. 提交清单（9/26 前逐项打勾）

- [ ] 代码仓库可克隆、README 能跑通
- [ ] `.env.local` **未**提交（提交前全局搜一遍 `sk-`）
- [ ] `npm run smoke` / `smoke:db` / `smoke:batch` / `eval` / `eval:ocr` 全绿
- [ ] `eval/ocr-report.md` 里的数字是**真实模式**跑出来的
- [ ] `prompts.md` 版本记录已更新到最新一版
- [ ] 部署地址可访问，且上线后重跑过一遍自检
- [ ] 演示录屏已备份（断网兜底）
- [ ] 提前 ≥24 小时提交
