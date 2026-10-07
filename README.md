# 🎭 舞台提示台 · Cue Rail

供剧团**联排**与**正式演出**使用的舞台提示台（场记排程 + 操作员执行台）。
Node.js + Express + SQLite（better-sqlite3）+ 纯浏览器界面，无外部数据库依赖。

## 功能一览

- **场记编排（草稿）**：按场次编排灯光 / 音效 / 换景提示，填写**顺序、相对上一条的等待秒数、操作说明**；
  上下移动调整顺序后**自动重新计算每条预计时间（累计）与总时长**；等待时长**拒绝负数/非整数**，保存整体失败、不会写入半截数据。
- **不可变发布版本**：发布时把草稿快照成版本；此后草稿修改**不影响**任何已发布版本，也不影响**进行中的演出**（演出始终使用启动时的版本快照）。
- **演出执行**：操作员从指定版本启动演出，凭
  - **操作请求号 `requestNo`**（幂等）和
  - **所见进度号 `progressNo`**（乐观并发）

  对当前提示**确认执行**或**跳过**。
- **跳过撤销**：跳过后，只要下一条尚未处理，可**撤销最后一次跳过并回到该提示**；被撤销位置必须是处理序列的最后一条且为「跳过」；**执行过的提示不能撤销**。
- **操作协议（关键规则）**
  | 情形 | 处理 |
  |---|---|
  | 同号同内容重试 | 返回原结果（`replayed`），不重复执行 |
  | 同号异内容 | 拒绝（409 `REQUEST_CONFLICT`） |
  | 进度号过期（所见 &lt; 服务器） | 返回当前进度与清单，**不改变任何状态**（409 `STALE_PROGRESS`） |
  | 进度号超前（所见 &gt; 服务器） | 拒绝并返回当前进度（409 `AHEAD_PROGRESS`） |
  | 对非当前提示执行/跳过 | 拒绝并指明当前应处理的提示 |
  | 演出已结束仍操作 | 拒绝 |
- **操作记录**：每次尝试都记录**操作员、时间、版本、请求号、动作、提示号、所见进度、结果与非法原因**（含被拒、进度冲突、幂等重试）。
- **界面**：场记编排、发布版本、演出控制台（当前提示高亮、进度号、状态、轮询同步）、操作记录四个页签；所有非法操作均**明确弹出原因**。

## 一键启动（Docker Compose，推荐）

```bash
cd cue-rail
docker compose up -d --build
```

启动后访问：

- **http://localhost:3000**

数据保存在 Docker 卷 `cue-data`（容器内 `/data/cuerail.db`，含 WAL 文件），容器重建不丢数据。

常用命令：

```bash
docker compose logs -f          # 查看日志
docker compose down             # 停止（保留数据卷）
docker compose down -v          # 停止并删除数据（重新初始化）
```

## 配置

通过环境变量（可复制 `.env.example` 为 `.env` 后修改）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST_PORT` | `3000` | 宿主机暴露端口（Compose 用），改它即改浏览器访问端口 |
| `PORT` | `3000` | 容器内监听端口（一般无需改） |
| `DB_PATH` | `/data/cuerail.db` | SQLite 数据库文件路径 |
| `SEED_ON_EMPTY` | `true` | 首次启动且库为空时，初始化示例场次（含一个已发布 v1 与未发布草稿），改为 `false` 得空库 |
| `TZ` | `Asia/Shanghai` | 容器时区（界面时间按浏览器本地时区显示） |

## 本地运行（不用 Docker）

要求 Node.js ≥ 20。

```bash
npm install
npm start                 # 默认数据文件 ./data/cuerail.db，首次自动建表并初始化示例数据
# 浏览器打开 http://localhost:3000
```

可选环境变量：`PORT=3000 DB_PATH=./data/cuerail.db SEED_ON_EMPTY=true npm start`

## 界面使用指引

1. **① 场记编排**：选择/新建场次，维护灯光/音效/换景提示，调整顺序、等待秒数与说明，「保存草稿并重算时间」。满意后「发布为不可变版本」。
2. **② 发布版本**：查看每个不可变版本的完整提示单（顺序、相对等待、预计时间）。
3. **③ 演出控制台**：
   - 「从指定版本启动新演出」选择版本、填写操作员后启动；
   - 每次操作点「生成」拿到新**请求号**，界面顶部显示**所见进度号**；
   - 高亮起的一行是当前待处理提示，点「确认执行 / 跳过」；
   - 撤销仅在「最后一次处理为跳过」时可用；全部处理完可「结束演出」；
   - 若另一台终端已推进进度，提交时会收到「进度号过期」提示并自动刷新，状态不会被覆盖。
4. **④ 操作记录**：全部操作审计（可按演出过滤、隐藏幂等重试），含非法操作原因。

## HTTP API 摘要

- `GET /api/shows`，`POST /api/shows`
- `GET /api/shows/:id`（草稿+版本列表）
- `PUT /api/shows/:id/cues` — 整体替换草稿，body：`{ "cues": [{ "cueType": "light|sound|scene", "title", "waitSecs": >=0 整数, "instruction" }] }`，顺序即数组顺序
- `POST /api/shows/:id/publish` — 发布不可变版本
- `GET /api/shows/:id/versions`、`GET /api/versions/:id`
- `POST /api/performances` — `{ "versionId", "operator" }`
- `GET /api/performances`、`GET /api/performances/:id`
- `POST /api/performances/:id/ops` — 执行操作：

```json
{ "requestNo": "REQ-...", "action": "execute|skip|undo|end",
  "cueSeq": 1, "progressNo": 0, "operator": "张三" }
```

- `GET /api/logs?performanceId=...`

所有错误返回 `{ "error": "CODE", "reason": "中文原因" }`，4xx 状态码区分非法类型。

## 目录结构

```
src/db.js       建表 / 迁移 / 首次初始化示例数据
src/server.js   REST API 与操作协议（事务、幂等、进度控制、审计）
public/         浏览器界面（原生 HTML/CSS/JS，无构建步骤）
Dockerfile / docker-compose.yml / .env.example
```
