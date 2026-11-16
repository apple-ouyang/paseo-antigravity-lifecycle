# antigravity-lifecycle（Paseo 插件）

为 Antigravity CLI（`agy`）安装 Paseo 生命周期 hook（`~/.gemini/config/hooks.json` 的 `"paseo-status"` 分组），把 `PreInvocation`、`PostInvocation` 和 `Stop`（含官方 `fullyIdle: true | false` 信号）原子落盘到 `<brainDir>/.system_generated/logs/hook-state.json`，供 Paseo 的 `acp-agent` 会话在后台任务、子代理与唤醒思考间隙保持回合 running。

## 为什么需要这个插件

`agy acp` 在前台第一轮调用结束时会立即返回 `{ stopReason: "end_turn" }`，即便后台 `run_command`（`WaitMsBeforeAsync` 超时转后台）或 `invoke_subagent` 仍在运行。此时 Antigravity 官方 `Stop` hook 的输入里会带 `"fullyIdle": false`；等后台任务或子代理全部结束、唤醒回合真正收尾后，`Stop` hook 才会给出 `"fullyIdle": true`。

本插件在不改动 `"orca-status"` 与 `"thread-scope"` 的前提下，在 `~/.gemini/config/hooks.json` 维护独立的 `"paseo-status"` 命名分组：

1. `PreInvocation` / `PostInvocation`：向 stdout 输出 `{}`（符合 `agy` protojson 要求），并写入 `<dirname(transcriptPath)>/hook-state.json`。
2. `Stop`：向 stdout 输出 `{"decision":""}`，并把 `fullyIdle: true | false` 写入 `<dirname(transcriptPath)>/hook-state.json`。

## 安装与验收

```bash
cd paseo-plugins/antigravity-lifecycle
npm install
npm run typecheck
npm test
paseo plugin install ./paseo-plugins/antigravity-lifecycle
paseo plugin ls                   # 要求 antigravity-lifecycle = running
```
