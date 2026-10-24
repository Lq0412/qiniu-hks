# 今日不办 · Linx 语音办事闯关

三个难搞柜员，三枚印章。玩家在自己的网页里用语音协商，争取下班前拿到虚构的“快乐生活许可证”。支持文字补充，柜员仍由 Linx 语音回复。

玩法参考 [ChatDMV](https://devpost.com/software/chatdmv)，中文场景、人物和代码独立制作。原“图灵审讯”已停止，旧开发分支及 Issue 已清理；小修直接提交，核心规则和接入走 PR。

## 启动

需要 Node.js 24。首次执行 `npm ci`，然后 `npm start`，打开 [本地游戏](http://127.0.0.1:4173/)。服务仅监听本机，不直接用于公网部署。

首次运行生成被 Git 忽略的 `.linx-device.json`，其中是测试设备标识。将本机设备绑定到 Linx 智能体，并在角色设定中使用 [counters.mjs](counters.mjs) 的 `agentPrompt` 内容，保留 `{{counter_brief}}` 占位符。设备已绑定后，OTA 令牌由服务端获取，仅留内存，不进入前端或日志。

页面点击“取号”查看目标和线索，再接通柜员、允许麦克风。按住按钮或空格说话、松开发送。每窗至少两轮有效沟通且态度达到75盖章，三分钟未办成则超时；拿到章后点击下一窗口。

## 检查与实测

- `npm run check`：语法检查。
- `npm test`：离线规则、协议和HTTP测试。
- `npm run test:rules`：核心规则分支覆盖率至少90%。
- `npm run test:coverage`：自有服务端行覆盖率至少80%。
- `npm run smoke:linx -- 0`：真实平台首窗口测试；参数1/2分别测后续窗口，会消耗少量平台额度。不能把离线测试当成平台接通。

## 文档

- [当前需求、架构与验收](docs/counter-design.md)
- [协作规范](CONTRIBUTING.md)
- [初步调研](docs/research/README.md)
- [实际验证记录](docs/counter-validation.md)

已知边界：语义评价依赖模型，可能存在评分或台词偏差；客户端与服务重启会断开当前语音，游戏进度保存在服务端内存。只支持本机单设备使用，不包含多人和持久化账号。
