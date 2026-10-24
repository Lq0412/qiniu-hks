# 项目协作约定

## 控制复杂度与范围

引用 opencode AGENTS.md 英文原文：
> Before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain the concrete failure mode, likelihood, and complexity cost to the user and get their buy-in. Do not silently expand scope for theoretical robustness.

中文版：为推测性或发生概率极低的竞态、安全边界情况增加复杂度前，先向用户说明具体失效方式、发生概率与复杂度成本，并取得用户认可。不要为了理论上的健壮性悄悄扩大范围。

- 在本项目中，遇到此类推测性问题时，停下这部分实现，在最终总结或 PR 中报告具体失效方式、概率与复杂度成本，等待用户认可。
- 真机或测试中实际复现的问题可以直接修复。
- 改动范围只限当前任务要求。

## 分支与交付

- 不直接推送 main；所有改动通过 PR 交付。
- push 前必须运行并通过 `npm test` 和 `npm run check`。
- PR 标题、正文使用中文；用 `Refs #N` 指向对应的 ADR issue（标签为「决策记录」）。
- 无需 ADR 的小改动，在 PR 中注明「小改动，无需 ADR」。
- PR 附测试清单；涉及语音行为变化时，增加「需真机验收」一节。
- 架构变化时同步更新 `docs/architecture.md`。

## LINX 凭据与连接

- LINX 凭据（设备 JSON、API key、`LINX_DEVICE_JSON` / `LINX_API_KEY` 的值）绝不进入代码、提交、日志、测试或 PR 文字。
- 测试只使用假 WSS，不连接真机。
- 遵守每台设备只能有一个 Linx WSS 连接的约束。
