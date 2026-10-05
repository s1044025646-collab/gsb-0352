# 单败淘汰赛签表服务（TypeScript + Node.js + SQLite）

虚构赛事的单败淘汰赛后端：导入带稳定编号与种子顺序的参赛者，生成最小二次幂签表，
按确定的种子展开规则排位，处理轮空、真实结果提交、晋级与冠军产生。
仅 API 与 CLI，无前端；不依赖 Docker / WSL / 外部服务。

## 环境要求

- Windows 本地，Node.js >= 22.5（使用内置 `node:sqlite` 与 TypeScript 类型擦除运行，无需原生编译）
- 依赖仅 `typescript` 与 `@types/node`（开发用）

## 快速开始

```powershell
npm install
npm run build     # tsc 类型检查并编译到 dist/
npm test          # node:test 单元测试（15 个用例）
npm run demo      # 5 人 -> 8 签位演示：3 个首轮轮空，按不同顺序提交，产生唯一冠军
npm start         # 启动 API，默认自动选择空闲端口；--port 8080 或 PORT 环境变量可指定
```

数据目录默认为项目内 `data/`（可用 `DATA_DIR`、`DB_PATH` 环境变量覆盖）。

## 核心规则

- **种子展开**：从 `[1,2]` 开始，每个已有种子 `s` 展开为 `s` 与 `newSize+1-s`，
  8 签位顺序为 `1,8,4,5,2,7,3,6`，头号种子优先面对空缺的高号种子。
- **三种来源状态**：`participant`（已确定）、`empty`（已知空签位）、`pending`（上轮未决出）。
  只有两侧来源都已解决且恰有一名参赛者时才自动晋级（`BYE`）；两边都空传播 `EMPTY`；
  一侧未决绝不当作轮空。
- **真实结果**：两名参赛者都确定后才允许提交；胜者必须属于本场；每场只记胜者，不记比分。
- **自动晋级不是比赛**：`BYE`/`EMPTY` 与 `REAL` 明确区分，完整 n 人赛恰有 n-1 条真实结果。
- **冻结**：冻结后参赛者与种子不可再修改。
- **撤销**：仅当该场下游没有任何真实结果时允许，撤销后自动晋级由回放重新推导，
  无关分支不受影响；下游已有真实结果则返回 `UNDO_BLOCKED` 并列出阻塞场次。
- **幂等与版本**：相同幂等键重复提交返回旧结果；同键不同内容返回 `IDEMPOTENCY_CONFLICT`；
  `expectedVersion` 过期返回 `STALE_VERSION`。提交/撤销在单一事务中完成。
- **边界**：零人拒绝（`EMPTY_TOURNAMENT`）；单人直接成为冠军且不生成比赛；
  人数上限可配置（`maxParticipants`，默认 1024）。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/tournaments` | 创建赛事 `{name, maxParticipants?}` |
| POST | `/tournaments/:id/participants` | 导入种子 `{participants:[{id,name}]}`，数组顺序即种子顺序 |
| POST | `/tournaments/:id/freeze` | 生成并冻结签表 |
| GET | `/tournaments/:id/bracket` | 查看完整签表 |
| GET | `/tournaments/:id/playable` | 可比赛场次 |
| POST | `/tournaments/:id/matches/:round/:index/result` | 提交胜者 `{winnerId, idempotencyKey?, expectedVersion?}` |
| DELETE | `/tournaments/:id/matches/:round/:index/result` | 撤销结果 `{expectedVersion?}` |
| GET | `/tournaments/:id/participants/:pid/path` | 参赛路径 |
| GET | `/tournaments/:id/replay` | 从真实结果回放（可比赛列表 + 冠军） |
| GET | `/tournaments/:id/export` | 导出全部数据 |

错误统一为 `{error:{code,message,details?}}`，错误码包括：
`INVALID_INPUT` `NOT_FOUND` `EMPTY_TOURNAMENT` `TOO_MANY_PARTICIPANTS` `ALREADY_FROZEN`
`NOT_FROZEN` `MATCH_NOT_READY` `MATCH_ALREADY_DECIDED` `WINNER_NOT_IN_MATCH`
`IDEMPOTENCY_CONFLICT` `STALE_VERSION` `UNDO_BLOCKED` `NOT_REAL_RESULT`。

## CLI

```powershell
npm run cli -- create --name 演示杯 --max 64
npm run cli -- import 1 --file seeds.json     # seeds.json 为 [{id,name},...]，顺序即种子
npm run cli -- freeze 1                       # 冻结并打印分轮签表
npm run cli -- playable 1
npm run cli -- submit 1 1 1 D4 --key m11      # 提交 轮次 场次 胜者
npm run cli -- undo 1 1 1
npm run cli -- path 1 A1
npm run cli -- replay 1
npm run cli -- export 1
npm run cli -- bracket 1
```

CLI 以分轮表展示，来源标注为参赛者编号、`(空)` 或 `(未决)`。

## 存储

SQLite 表：`tournament`（含 `size`、`status`、`version`）、`participant`（稳定编号 + 种子）、
`real_result`（真实结果 + 幂等键）、`auto_advance`（BYE/EMPTY 快照）。
重启后由真实结果回放推导，得到与之前一致的可比赛列表与冠军。

## 已知限制

- 撤销粒度为单场真实结果，不支持赛事整体回滚。
- 自动晋级记录为冗余快照，权威来源始终是真实结果 + 签表推导。
- `node:sqlite` 在 Node 25 仍标记为实验特性（会打印一条警告），功能稳定可用。
