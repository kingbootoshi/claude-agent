---
name: claude-code-orchestrator
description: Use when Codex should spawn, monitor, steer, or review Claude Code agents through the local claude-agent tmux CLI/service, especially for frontend workbench variants and Opus design passes.
triggers:
  - claude-agent
  - claude code orchestrator
  - Claude Code agents
  - Opus variants
  - workbench variants
  - manage Claude Code
---

# Claude Code Orchestrator

Use `claude-agent` when Claude Code should do implementation, frontend exploration, visual variant generation, or review work in the background while Codex keeps orchestration context small.

## Defaults

- Model: `opus` - resolves to Opus 4.7 on first-party Anthropic.
- Effort: `max` by default. Prefer `--xhigh` for bulk workbench variant sweeps.
- Permission mode: `auto`.
- Runtime: tmux session per agent.
- State: `~/.claude-agent/jobs`.

## Standard Loop

```bash
claude-agent start "Task prompt" --dir /path/to/repo --map --xhigh
claude-agent await-turn <jobId>
claude-agent capture <jobId> 160 --clean
claude-agent send <jobId> "Follow-up instruction"
claude-agent await-turn <jobId>
claude-agent capture <jobId> 220 --clean
```

Use `claude-agent jobs --json` for compact status and `claude-agent attach <jobId>` when a human needs the live tmux session.

## Workbench Variant Prompt Shape

Ask Claude Code to read only the compressed design inputs:

```text
Read apps/workbench/AGENT_DESIGN_RULES.md, src/generated/theme-summary.md, and apps/workbench/src/variants/<context>/<brief>/brief.md.
Create v1-v5 as distinct React/Tailwind variants that obey the variant contract.
Run the workbench design check and fix violations.
Report the files changed and the visual direction of each variant.
```

For bulk variants use `--xhigh`. For final convergence or hard review use default `max`.

## Local Service

Use the service when another CLI needs to manage agents:

```bash
TOKEN="$(claude-agent service token)"
curl -sS -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"prompt":"Review this workbench brief","cwd":"/path/to/repo","effort":"xhigh"}' \
  http://127.0.0.1:4877/jobs
```

Start it with:

```bash
claude-agent service start
```

## Rules

- Keep prompts bounded. Link to maps, briefs, and generated summaries instead of pasting large files.
- Use `await-turn`, then `capture --clean`; do not stream huge tmux logs into the main context.
- Use `send` to continue the same agent after scoping so it keeps its local context.
- Use `kill` only when an agent is stuck or clearly off-track.

