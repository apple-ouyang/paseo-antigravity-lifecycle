Antigravity lifecycle integrates Antigravity CLI (`agy`) lifecycle hooks with Paseo so ACP sessions stay active while background commands or subagents are still running.

It records `PreInvocation`, `PostInvocation`, and `Stop` (with `fullyIdle: true` or `false`) events into the local `hook-state.json` file. Paseo uses this state to hold turns open until the agent is genuinely idle rather than ending the turn prematurely on intermediate tool boundaries.

Requires Antigravity CLI (`agy`) installed on the daemon host. All hook state is stored locally on the daemon host.
