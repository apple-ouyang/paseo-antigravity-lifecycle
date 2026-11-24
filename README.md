# Antigravity Lifecycle & Orchestration Console (`antigravity-lifecycle`)

Integrates Antigravity CLI (`agy`) lifecycle hooks with Paseo, turns opaque `Other` ACP tool calls into structured timeline cards, and provides a live multi-mode orchestration console panel for **Swarm**, **Teamwork**, **Boost**, **`/goal`**, **Plan**, **Workflow**, subagents, and background tasks.

## Features

1. **Semantic Timeline Cards (No More `Other`)**
   - Intercepts `name === "other"` tool calls (`post_message`, `swarm`, `read_board`, `swarm_wait`, `invoke_subagent`, `define_subagent`, `send_message`, `manage_subagents`, `run_workflow`, `update_steps`, `enter_plan_mode`, `exit_plan_mode`, `schedule`, `manage_task`, `ask_question`, and generic custom tools).
   - Renders compact, theme-aware cards with `@mention` badges, checklist progress, expandable full content, and on-demand message board backfill for `read_board` / `swarm_wait`.
2. **Live Multi-Mode Console Panel (`agy-console`)**
   - Open via the composer pill popover, `/swarm-board`, `/agy-board`, command palette, or any Swarm/Teamwork timeline card.
   - **Overview**: Swarm `plan.json` goals and threads, live member status/model/worktree/unread count/latest substantive activity, Teamwork 5-stage pipeline indicator, `/goal` summary, Plan step checklist, Workflow runs, and background commands/timers.
   - **Message Board**: Real-time `board.jsonl` feed with `@member` filtering, newest/chronological sorting, screenshot tags, and safe directive dispatch through the coordinator.
   - **Nested Agent Tree**: Recursive scanning (up to 5 levels) of Teamwork hierarchies (`Teamwork` → `Interviewer` / `Project Orchestrator` → `Sub-orchestrator` → `Explorer` / `Worker` / `Reviewer` / `Challenger` / `Auditor` / `Victory Auditor`) and regular subagents, with deep running state bubbling.
   - **Child Live Transcript**: Click any Swarm worker or Teamwork/regular subagent to inspect its recent execution steps in real time (auto-refreshes every 3s while running; strictly scoped to children of the current session).
3. **Lifecycle Hook Integration & Live Composer Pill**
   - Installs `~/.paseo/agent-hooks/antigravity-hook.mjs` under `~/.gemini/config/hooks.json` (`paseo-status`).
   - Polls active `antigravity` / `antigravity-cli` / `agy` sessions every 2s, verifying OS PID liveness so terminated sessions clear immediately.

## Development & Verification

```bash
npm test
npm run typecheck
```
