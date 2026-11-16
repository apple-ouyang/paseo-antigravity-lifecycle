Antigravity lifecycle integrates Antigravity CLI (`agy`) lifecycle hooks with Paseo so ACP sessions stay active while background commands or subagents are still running.

It records `PreInvocation`, `PostInvocation`, and `Stop` (with `fullyIdle: true` or `false`) events into the local `hook-state.json` file. Paseo uses this state to hold turns open until the agent is genuinely idle rather than ending the turn prematurely on intermediate tool boundaries.

When enabled, the plugin writes a hook script to `~/.paseo/agent-hooks/antigravity-hook.mjs` and registers it under a `paseo-status` key in `~/.gemini/config/hooks.json` so `agy` runs it on `PreInvocation`, `PostInvocation`, and `Stop`. Other entries in that file are left alone. Removing the plugin does not delete the script or the entry; delete both to uninstall.

Requires Antigravity CLI (`agy`) installed on the daemon host. All hook state is stored locally on the daemon host.
