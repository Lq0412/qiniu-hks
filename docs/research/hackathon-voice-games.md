# 语音游戏黑客松作品复核与复刻选型

日期：2026-10-24。最终选择：用户已确定 ChatDMV 类办事闯关，见 [当前设计](../counter-design.md)。下文保留筛选依据。目标：从真实参赛作品选择可快速改造到灵矽的语音游戏，减少原创玩法试错。本次为公开资料及部分源码静态核查，未运行候选项目，也未完成视频播放验证。

## 早期建议：Talk2Win（未采用）

推荐复刻其“读任务 → 自由讲话 → 角色反馈 → 目标进度 → 胜负”循环。理由是浏览器实现、可找到源码与许可证、规则直观，适合演示。不是因为已证实获奖：本次仅确认它提交到 ElevenLabs x 16z Worldwide Hackathon，没有找到获奖凭据。

- [参赛项目页](https://devpost.com/software/talk2win)
- [公开源码](https://github.com/gtanczyk/talk2win-hackathon)
- [项目页关联视频](https://www.youtube.com/watch?v=5cvgYk18MbI)（已取得入口，本次播放抓取受限，未观看验证）
- [LICENSE](https://github.com/gtanczyk/talk2win-hackathon/blob/master/LICENSE)

原作提供演讲与说服场景。我们的首个复刻范围只取“鼓舞准备退缩的队伍”，不做多个场景。保留任务简报、自由讲话、角色表情/台词、士气进度与结果。中文角色和台词另写；不把复刻工作声称为原创玩法。

### 源码静态评估

已查阅仓库文件树及 `ScenarioEngine.ts`、`Gemini.ts`、`ElevenLabs.ts`、`package.json`。

- 原引擎有 10 个可视角色；Gemini 通过一次结构化调用更新角色数组和目标进度，并非每个角色都必须建立独立语音连接。
- 原作将模型和 TTS 调用放在浏览器侧，使用 VITE_* 环境变量。移植时必须将凭据与服务调用移到后端，不能直接照搬。
- 原音频实现等待整个响应收齐后解码播放。灵矽实时语音不是同一接口，接入层需要按平台协议改造，不能只换 URL。
- 仓库 LICENSE 为 Apache-2.0，但 package.json 写 ISC；复用前保留两处声明并核对适用范围，记录修改与来源，不直接删掉作者信息。
- 仓库已经归档，依赖与 Windows 启动脚本需实际检查，不能把“有源码”等同于“今天可直接启动”。

### 灵矽改造路线（尚未实测）

自己的网页负责场景、录音交互、字幕和状态；灵矽负责实时语音角色。先只让一位队长口头回应，其余队员表现为反馈，减少多语音并发。状态可通过平台工具与我们的后端同步，但需要先验证工具调用时序和会话绑定。

交付顺序：跑通上游最小页面并记录可运行性 → 确认首场景与中文目标 → 验证灵矽真实语音和状态工具 → 迁移界面与规则 → 完整试玩验收。原审讯原型保留为历史实验，不继续为其添加内容。

## 候选对照

以下“适合程度”为本项目工程判断；项目描述来自作者或赛事页面，不等于本次实机体验评价。

| 作品 | 核实的赛事/奖项 | 循环与适配判断 | 源码与演示状态 |
|---|---|---|---|
| Talk2Win | ElevenLabs x 16z Worldwide Hackathon 参赛，未确认奖项 | 自由演讲影响角色与目标进度；首选复刻 | 公开源码与 LICENSE 已查看；视频入口存在但未播放 |
| ChatDMV | Stevens QuackHacks 2026，项目页标记 MLH Best Use of ElevenLabs 获奖 | 在办事窗口和不同性格角色周旋、限时闯关；易理解，但角色内容需制作 | 项目页有视频和 Drive 入口；本次未找到项目页提供的源码链接。确认语音输出，未确认麦克风输入 |
| Explain Yourself | SteelHacks XIII 参赛，未确认奖项 | 按住说话说服 NPC，通过进度和表情反馈；单角色实现很合适 | 找到源码，GitHub API license=null，根目录未见 LICENSE；不直接搬代码/素材 |
| ATC-Trainer | SwampHacks XI，项目页标记 Best Use of ElevenLabs 获奖 | 语音指挥飞机起降，有明确状态动作；机场模拟和引擎工作较多 | 项目页提供源码和演示视频入口 |
| Vox Populi | ElevenLabs Worldwide Hackathon，官方总结列 London 第三名 | 语音与 3D NPC 交流、指挥和锻造；场景与角色系统较重，不建议完整复刻 | 项目页有视频；未找到经确认的同项目公开源码 |
| Interrogation（Jason Poindexter） | 仓库自述参加 Mistral Worldwide Hackathon 2026 Online Track，未确认获奖 | 语音追问一个说谎嫌疑人，再提交具体指控；规则完整，但仍需案件质量 | 源码可见；LICENSE 限制再分发，不用于直接代码复刻 |

## 证据入口

- ChatDMV：[参赛及奖项页面](https://devpost.com/software/chatdmv)；[视频入口](https://www.youtube.com/watch?v=ZtT6_FRdquE)。
- Explain Yourself：[参赛及机制说明](https://devpost.com/software/explain-yourself)；[作者仓库](https://github.com/Ryan-M-Smith/explain-yourself)。
- ATC-Trainer：[参赛及奖项页面](https://devpost.com/software/atc-trainer)；[源码](https://github.com/lucasmcclean/atc-view)。
- Vox Populi：[参赛页](https://devpost.com/software/vox-populi-z630sy)；[主办方获奖总结](https://elevenlabs.io/blog/announcing-the-winners-of-the-elevenlabs-worldwide-hackathon)；[视频入口](https://www.youtube.com/watch?v=mPyrWESOFy4)。
- Interrogation：[作者仓库](https://github.com/jpoindexter/interrogation-game)；[许可证原文](https://raw.githubusercontent.com/jpoindexter/interrogation-game/main/LICENSE)。

旧材料中的 Turing Blend、AMNESIAC 未在本轮取得足够可靠的原始证据，不据此声称获奖或选择为代码复刻对象。GibberLink 是通信演示，不作为本次完整游戏候选。

## 关于“交差”

尚未取得本次七牛活动的具体参赛规则，不能确认既有项目改编的申报要求。实现与提交材料应列明上游来源、保留许可和修改说明，准确描述自己的灵矽接入与中文场景工作；不把其他比赛获奖等同于本次参赛资格。
