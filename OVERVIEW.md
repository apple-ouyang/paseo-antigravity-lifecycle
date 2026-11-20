Antigravity lifecycle integrates Antigravity CLI (`agy`) lifecycle hooks with Paseo and adds a composer pill with a live detail popover for active background work.

`agy acp` can finish its foreground prompt turn while background commands, `invoke_subagent` runs, `swarm` teams waiting on `swarm_wait`, or `/goal` loops are still active (`Stop` fires with `fullyIdle: false`). The plugin polls active `antigravity` and `antigravity-cli` sessions every 2 seconds, reads each session's transcript, swarm member state, and hook files, and updates the composer pill (`background running` / `waiting for wakeup`) without restarting the Paseo daemon.

The hook script writes the hosting `agy` process ID from `PASEO_HOOK_AGENT_PID` into `process.json` on `PreInvocation` and `Stop`, and writes `hook-state.json` on `Stop` only so `ask_question` turns do not trigger false busy states. The server verifies OS process liveness before reporting active background work, so terminated or archived sessions clear immediately.

When enabled, the plugin writes `~/.paseo/agent-hooks/antigravity-hook.mjs` and registers it under a `paseo-status` key in `~/.gemini/config/hooks.json` for `PreInvocation`, `PostInvocation`, and `Stop`, leaving other entries untouched. Removing the plugin does not delete the script or the `paseo-status` entry; delete both to uninstall completely.

Requires Antigravity CLI (`agy`) installed on the daemon host. All session logs under `~/.gemini/antigravity-cli/brain` and hook state are read locally on the daemon host, with no external network requests.
