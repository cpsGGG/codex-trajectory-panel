---
name: trajectory-panel
description: Operate and troubleshoot the locally installed Codex desktop trajectory panel. Use when the user asks about the embedded “轨迹” tab, per-task model/tool/input/token/timing trace, its startup behavior, or removing it.
---

# Codex 内嵌轨迹

This plugin has a local Windows companion that injects a read-only trajectory view into Codex desktop through a loopback-only Chrome DevTools connection.

## Behavior

- Read session data only from `%USERPROFILE%\.codex\sessions`, `%USERPROFILE%\.codex\archived_sessions`, and `session_index.jsonl`.
- Never upload session contents.
- Keep debugging and control listeners bound to `127.0.0.1`.
- Do not modify files inside the signed Microsoft Store package.
- Use the “对话 / 轨迹” tabs in the Codex task window. The trajectory tab updates while the active task is running.
- The default timeline is equal-width request/event sequence, matching DeepSeek Harness. “Duration” switches to idle-compressed durations; “Turns” and “Calls” fold the ledger.
- Assistant records own a numbered model request and expose output/reasoning/content tokens, linked tools, and derived TTFT/generation/throughput. Tool records expose Summary, Payload, Result, Schema, and Timing.
- Treat TTFT and generation timing as derived estimates because Codex session JSONL does not preserve provider-side streaming telemetry.

## Local operations

- Install or repair startup integration with `scripts/install.ps1`.
- The installer also registers the current-user `Codex Trajectory Panel Watchdog` scheduled task. It runs `scripts/watchdog.vbs` once per minute, exits immediately when the companion is healthy, and does not open Codex when Codex is intentionally closed.
- Launch Codex through the companion with `scripts/launch-codex.vbs`.
- Inspect `~/.codex/trajectory-panel/companion.log` when the status dot is red or the panel is missing.
- Remove only this plugin's shortcuts/background process with `scripts/uninstall.ps1`.

When troubleshooting, first validate that Node.js exists, port 9333 is loopback-only, and the Codex renderer target is available at `app://-/index.html`.
