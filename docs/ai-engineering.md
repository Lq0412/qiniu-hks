# AI 工程实践：从玩法到真机验收

本项目单人参赛，使用多助理分工推进。用户在关键决策和最终试玩时出场，日常调研、拆任务、编码、验收和演示准备由 AI 小队执行。分工与工具迁移来自项目开发计划；PR 标题、状态及时间以 GitHub 查询结果为准。协作方式不等于已量化的效率收益，本文不估算节省工时或生成代码比例。

## 分工与编码方式

| 助理 | 职责 | 产物 |
| --- | --- | --- |
| 队长 / 统筹 Pema | 方向收敛、任务拆分、审查与验收协调 | 决策记录、审查清单 |
| 玩法策划 小策 | 场景、角色、题卡、投票规则与结局 | 玩法稿与模板 |
| 开发 小码 | 实现、测试、语音探针与问题修复 | 分支、提交、PR |
| 路演 / 演示 小演 | 讲稿、演示流程与录屏 | 路演资料；演示视频仍待补 |

编码先使用 Cursor 云端编码助理，每个任务一个分支和 PR；随后改用共享电脑上的 Codex 命令行，由助理自己跑测试、提交并开 draft PR。开发日志记录工具迁移，不能只凭 PR 时间反推各工具的贡献比例。

每个 PR 先审后合：队长审查、CI 绿后才 squash 合并，不直接推 main。审查问题回到原分支修订，保留可追踪的过程。当前文档交付只推 `docs/submission` 并开 draft PR，不执行合并。

## 从探针到自动验收

- `npm run speak:round`：真实设备上依次播角色台词，检查单连接、非空音频、逐句文本与注入回声过滤。
- `npm run presynth`：按清单逐句合成固定台词；核对音色、文本和文件后跳过已有项，每完成一句保存清单，支持中断后增量补齐。
- 无头驱动直接调用 `/api/mixin`，按 create → start → step/tick → text/confirm → vote → reveal 打完整局；读取每句 WAV，统计请求等待、无音频和 cue 音色是否符合角色映射。驱动加入音频时长、阅读停顿与思考音的等待，模拟浏览器节奏，避免把预取效果测错。
- 音色映射一致不等于实际听感一定正确，仍需试听。人工最终试玩检查笑点、节奏、打断和揭晓的连贯性。

凭据通过环境变量在运行时注入，不进入仓库、日志或提示词。每台设备只允许一条 WSS，预合成与对局共用，不能并行启动两个真机程序。云端测试只用假 WSS，文字模拟不连接灵矽；真机测量与离线规则测试分开。具体数据和需真机验收项见[架构文档](architecture.md#真机验收记录与适用范围)。

## 规则与决策留痕

[AGENTS.md](../AGENTS.md) 要求：为推测性或极低概率的竞态、安全边界增加复杂度前，先报告具体失效方式、概率与复杂度成本，等待用户认可；真机或测试实际复现的问题可直接修复。它同时规定只改当前任务范围、PR 交付、push 前测试和凭据隔离。

架构及重大方向采用带「决策记录」标签的 GitHub issue，标题由 `gh issue view` 核实：

- [ADR-001 作品方向：从「人类模型测评」转向「谁是人类」（混入模型群）](https://github.com/Lq0412/qiniu-hks/issues/10)
- [ADR-002 分支与交付策略：main 保留旧版兜底，新玩法走特性分支](https://github.com/Lq0412/qiniu-hks/issues/11)
- [ADR-003 运行形态：Web 端 + 按住说话，文字模式不依赖麦克风](https://github.com/Lq0412/qiniu-hks/issues/12)
- [ADR-004 对局核心：服务端状态机 + 人味分，不用死关键词，每阶段超时兜底](https://github.com/Lq0412/qiniu-hks/issues/13)
- [ADR-005 语音调度：一局保持单条灵矽连接，每回合换音色，固定话术预合成兜底（已决定）](https://github.com/Lq0412/qiniu-hks/issues/14)
- [ADR-006 凭据处理：灵矽设备凭据只在运行时注入，不进仓库](https://github.com/Lq0412/qiniu-hks/issues/15)
- [ADR-007 胜负判定与计票口径](https://github.com/Lq0412/qiniu-hks/issues/18)
- [ADR-008 LLM 只负责配音和角色即兴，流程与关键文案由服务端确定](https://github.com/Lq0412/qiniu-hks/issues/19)

ADR 是当时的取舍记录，不等于全部目标已经交付。例如 #12 的按住说话仍为占位；实际支持范围以代码及架构文档为准。

## 真实 PR 时间线

快照：2026-10-25（北京时间），本次文档 PR 创建前。使用 `gh pr list --repo Lq0412/qiniu-hks --state all --limit 100 --json number,title,state,createdAt,mergedAt,url` 查询，返回 11 条 PR，其中 11 条已合并。按创建时间排序，合并时间统一转换为北京时间 UTC+8；本表不计 issue，也不把编号间隔当作 PR 数。

| PR | 标题 | 状态 | 合并时间（北京时间 UTC+8） |
| --- | --- | --- | --- |
| [#4](https://github.com/Lq0412/qiniu-hks/pull/4) | feat: 交付今日不办 Linx 语音闯关本地版 | MERGED | 2026-10-24 16:29:05 |
| [#6](https://github.com/Lq0412/qiniu-hks/pull/6) | feat: 人类模型测评与夯拉报告 | MERGED | 2026-10-24 17:22:49 |
| [#7](https://github.com/Lq0412/qiniu-hks/pull/7) | fix: 短回答反馈卡住与重试提示 | MERGED | 2026-10-24 17:33:35 |
| [#9](https://github.com/Lq0412/qiniu-hks/pull/9) | feat(benchmark): 评级护栏、型号风格解耦、模型卡覆盖率与语音静音 | MERGED | 2026-10-24 21:00:09 |
| [#16](https://github.com/Lq0412/qiniu-hks/pull/16) | feat(mixin): 谁是人类的局状态机和文字模式 | MERGED | 2026-10-24 23:07:26 |
| [#17](https://github.com/Lq0412/qiniu-hks/pull/17) | feat(probe): 灵矽语音能力探针（Draft） | MERGED | 2026-10-24 22:17:34 |
| [#21](https://github.com/Lq0412/qiniu-hks/pull/21) | fix: 人味分误伤与旧文案清理 (#20) | MERGED | 2026-10-24 23:25:55 |
| [#22](https://github.com/Lq0412/qiniu-hks/pull/22) | feat(ui): 谁是人类文字局前端 | MERGED | 2026-10-25 00:08:05 |
| [#23](https://github.com/Lq0412/qiniu-hks/pull/23) | feat(mixin): 谁是人类语音调度（单连接、换音色、预合成） | MERGED | 2026-10-25 00:50:49 |
| [#24](https://github.com/Lq0412/qiniu-hks/pull/24) | perf(voice): 语音局提速与迟到帧修复 | MERGED | 2026-10-25 01:54:55 |
| [#25](https://github.com/Lq0412/qiniu-hks/pull/25) | docs: 新增项目代理协作约定 | MERGED | 2026-10-25 01:49:42 |

## 本次提交验证

只修改 README、架构文档和本文，不改代码、测试或依赖。在 Node.js 24 下执行 `npm test`：124 项通过、0 失败；`npm run check` 通过，`npm run sim` 离线文字整局到达 result。首次测试因工作区缺少依赖失败，执行 `npm ci` 后重跑通过，未修改依赖文件。本次不连接真机，不把历史真机记录当作本次重测结果。
