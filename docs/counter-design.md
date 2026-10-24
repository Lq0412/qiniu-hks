# 今日不办：自己的网页 + Linx 语音闯关

状态：实现中，关联 Issue #3。玩法参考 [ChatDMV](https://devpost.com/software/chatdmv)，中文剧情、规则、美术和代码独立实现，不使用未经许可的原作素材。

## 最小玩法

玩家来领取虚构的“快乐生活许可证”，依次经过取号、材料审核、最终盖章三个窗口。开场显示来意和手头线索，玩家自由发言，柜员回应并改变态度。每窗从30分开始，单次评价-10到+25；至少两轮且达到75分盖章；0分拒绝，三分钟未过超时。集齐三个章通关。每次评价保留理由。语义评价依赖模型，后端只保证边界和生命周期。

## 技术边界

Node HTTP + ws；静态前端，WebAudio/AudioWorklet采集16k PCM；后端保管设备标识和OTA令牌，代理Linx WSS。默认只监听本机。Linx端侧MCP通过同一WS注册status/review，不需要公网服务器。

工具只在服务端执行，绑定游戏对象和当前窗口；客户端不能直接评价或盖章。每个STT形成一轮，同轮重复评价幂等；重开/换窗关闭旧连接，旧回调不得操作新局。更换窗口建立新会话，用hello custom_replace_prompt传入固定场景，防止前一柜员串角色。

音频格式按真实hello响应处理：上行请求PCM，实际协商通过16k PCM。若下行协商为Opus，后端用opusscript解码后推送PCM，浏览器统一通过WebAudio播放；不使用浏览器假配音替代Linx。按住说话支持中止旧播放，松开结束录音；离开时关闭麦克风与连接。

## 验收

- 新玩家可读到完整任务、柜员动机和可用线索。
- 真实OTA绑定、WS hello、MCP发现和调用、文本/音频往返分别记录结果。
- 有效说服能得到带理由的评价并盖章；非法、重复、旧轮次、旧窗口请求不会误推进。
- 三窗顺序、成功/失败/超时及重开可验证；语音接入失败有明确提示。
- 核心规则分支覆盖率≥90%，服务端行覆盖率目标≥80%；模拟测试与平台实测分开记录。

协议来源：[OTA](https://linx.qiniu.com/docs/xrobot/platform/OTA)、[WebSocket](https://linx.qiniu.com/docs/xrobot/platform/websocket)、[端侧MCP](https://linx.qiniu.com/docs/xrobot/mcp/hardware-mcp)。旧审讯分支已按用户要求删除。
