# 你是什么人类模型？

六道生活题，自由语音回答，最后获得一张有原话证据的“人类模型卡”。Linx 提供实时语音、模型回复和工具调用；自己的网页负责题目、确认和报告展示。

型号采用 GPT / Astra、Claude、Gemini、DeepSeek、通义千问、Kimi、豆包和虚构的4B小模型。型号表示回答风格；“夯爆了、顶级、人上人、NPC、拉完了”只评价本次表现，不是真实品牌性能排名。

## 试玩

Node.js 24，执行 `npm ci`、`npm start`，打开 http://127.0.0.1:4173/ 。点击开始，接通测试员，按住按钮或空格说话，松开发送；也可输入文字。检查转写后点击确认，六题后生成报告。

首次启动会生成被忽略的 `.linx-device.json`。设备需绑定 Linx 智能体，角色提示使用 `benchmark.mjs` 的 `agentPrompt`，保留 `{{counter_brief}}`。令牌只在服务端内存中使用。

## 验证

- `npm run check`：语法检查。
- `npm test`：规则、证据校验、音频资源、协议与HTTP测试。
- `npm run test:rules`：规则分支覆盖率至少90%。
- `npm run test:coverage`：自有服务端行覆盖率至少80%。
- `npm run smoke:linx`：六题真实平台链路测试，会使用平台额度；输入为合成文字，输出包含真实语音，不替代真人麦克风验收。

## 文档

- [玩法与架构](docs/human-benchmark-design.md)
- [概念与范围](docs/human-benchmark-concept.md)
- [型号调研快照](docs/research/model-tier-snapshot-2026-10-24.md)
- [开发规范](CONTRIBUTING.md)

仅用于本机单设备试玩，进度在服务端内存，重启清空。语义评价存在模型波动；速度暂不评分。早期柜员游戏文档保留为历史参考，不再是当前玩法。
