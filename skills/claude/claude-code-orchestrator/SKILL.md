---
name: claude-code-orchestrator
description: Spawn and manage sibling Claude Code agents through claude-agent for parallel frontend, workbench, implementation, and review tasks.
---

# Claude Code Orchestrator

Use the local `claude-agent` CLI to run background Claude Code agents in tmux:

```bash
claude-agent start "Task prompt" --dir /path/to/repo --map --xhigh
claude-agent await-turn <jobId>
claude-agent capture <jobId> 160 --clean
claude-agent send <jobId> "Continue with this correction."
```

Defaults are `--model opus --effort max --permission-mode auto`. Use `--xhigh` for broad workbench variant generation and default `max` for final review or hard implementation passes.

For workbench jobs, keep the prompt compact:

```text
Read apps/workbench/AGENT_DESIGN_RULES.md, src/generated/theme-summary.md, and the target brief.md.
Create v1-v5 distinct variants, run bun run check, and report files changed.
```

Use `claude-agent jobs --json` for compact status. Use `claude-agent attach <jobId>` for direct tmux interaction.

