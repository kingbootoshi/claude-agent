---
name: opus-agent-orchestrator
description: "Runs Opus/Claude Code agents through the local claude-agent tmux CLI/service for codebase exploration, frontend/workbench variants, implementation support, and second-model review. Trigger on /opus-agent-orchestrator, opus-agent, claude-agent, use opus agents, spawn opus, Claude Code agents, frontend variants, workbench variants, explore with Opus. Pairs with codex-orchestrator: Codex remains commander; Opus agents are specialist scouts/builders."
triggers:
  - /opus-agent-orchestrator
  - opus-agent
  - claude-agent
  - use opus agents
  - spawn opus
  - Claude Code agents
  - frontend variants
  - workbench variants
  - explore with Opus
---

# Opus Agent Orchestrator

Goal: Command Opus/Claude Code agents through `claude-agent` for bounded code exploration, frontend/workbench variants, implementation support, and second-model review while Codex keeps strategic control.

Success means:
- The right mode is selected and the prompt gives exact scope.
- Agent turns are awaited and captured in compact form.
- Findings are synthesized into decisions Saint can act on.
- Code-changing paths have explicit approval or an approved PRD.

Stop when: Saint has the synthesized result, every launched agent is either still intentionally working or has been exited, and the next action is clear.

Use `opus-agent-orchestrator` when Saint wants Codex to command Claude Code / Opus agents through the local `claude-agent` CLI or HTTP service. Codex stays the commander: it scopes the mission, starts agents, waits for turns, reads concise captures, sends follow-ups, synthesizes results, and reports back to Saint.

This complements `codex-orchestrator`. Use Codex agents as the default execution army. Add Opus agents when a second model lens is useful, especially frontend judgment, workbench variants, UI polish, product taste, exploratory review, or codebase reconnaissance where Opus may notice different patterns.

## Finished Means

- The right agent mode was chosen: explore, variant, implement, review, or service.
- Each agent had a bounded prompt with exact files, docs, or map references.
- `await-turn` completed and the output was captured with `--clean`.
- Findings were synthesized into plain English with file paths and decisions.
- Any code-changing path followed research -> propose -> approve -> implement unless Saint already gave explicit implementation approval.
- Idle sessions were exited with `/exit` or killed only when genuinely stuck.

## Why This Exists

Opus agents are expensive context. Their value comes from assigning narrow, high-leverage missions and then harvesting compact outputs. If Codex streams full terminal logs or starts agents with vague prompts, the main context fills with noise and the Opus session wastes its reasoning on rediscovery. The orchestrator pattern keeps Codex in strategic control while each Opus agent spends its context on the target problem.

## Prerequisites

```bash
claude-agent health
```

The CLI should report `tmux` and `claude`. Real-server verification should show the useful path in the actual session banner, such as `Opus 4.7 with high/max effort`. If `auth status` looks stale but real sessions work, trust the real smoke test over the status JSON.

## Default CLI Contract

`claude-agent` is installed at:

```bash
claude-agent
```

Defaults:

- Model: `opus`
- Effort: `max`
- Permission mode: `auto`
- State: `~/.claude-agent/jobs`
- Runtime: one tmux session per job

Use `--xhigh` for broad parallel work where cost/context matter. Use default `max` for final convergence, deep review, or hard architectural reasoning.

## Mode Selection

### Explore

Use this for codebase reconnaissance, architecture mapping, unfamiliar modules, or "tell me how this works" requests. Keep it read-oriented with `--permission-mode plan`.

Why: exploration agents produce the cleanest findings when they inspect and reason before changing state. Plan mode gives them the read-oriented surface they need for reconnaissance.

```bash
claude-agent start "Explore [area].

Read the relevant source files yourself. Report:
- entry points and data flow
- important file paths and line numbers
- existing patterns to preserve
- risks, ambiguities, and missing tests
- Key Findings: the 3-5 most important facts

Keep the run read-only. Return implementation options only when the prompt asks for them.
" --dir /path/to/repo --map --xhigh --permission-mode plan
```

### Workbench Variants

Use this for Axia/workbench frontend exploration, visual variant generation, UI polish, and product-facing flows.

Why: Claude Code / Opus is strong at frontend taste and can produce multiple coherent variants quickly. The prompt must point to compressed design inputs instead of pasting the whole app into the session.

```bash
claude-agent start "Read apps/workbench/AGENT_DESIGN_RULES.md, src/generated/theme-summary.md, and apps/workbench/src/variants/<context>/<brief>/brief.md.

Create v1-v5 as distinct React/Tailwind variants that obey the variant contract.
Run the workbench check and fix violations.
Report files changed and the visual direction of each variant.
" --dir /path/to/repo --xhigh --permission-mode auto
```

Use `--xhigh` for the first spread. Use `max` for the final chosen direction.

### Implement

Use this only after Saint has approved the plan or when the request explicitly asks for implementation.

Why: this skill can modify real codebases. The safe shape is research -> propose -> approve -> implement. Research is cheap and reversible; implementation is not. If approval is already present, continue without re-asking.

```bash
claude-agent start "PHASE: Scope then Implement

First read docs/prds/<feature>.md.

SCOPE:
- Read all files you need to modify.
- Identify exact changes.
- Note patterns to follow.
- Flag blockers.
- Report scope and wait.

IMPLEMENT after go-ahead:
- Follow the PRD exactly.
- Match existing patterns.
- Keep files modular and keep edits scoped to the requested surface.
- Run typecheck and relevant tests.
- Fix failures before reporting done.
" --dir /path/to/repo --permission-mode auto
```

After scope:

```bash
claude-agent send <jobId> "Scope looks good. Proceed with implementation."
```

If the scope needs adjustment, steer the same session so it can reuse the context it already built.

### Review

Use this after implementation for a second-model review. Prefer `--permission-mode plan` and `--xhigh` or default `max` depending on stakes.

Why: independent review catches different issues than the implementing agent. Review agents should look for correctness, security, data integrity, and missing tests; format and taste belong to lint, design review, or a separate UI pass.

```bash
claude-agent start "Review the recent changes for [feature].

Read docs/prds/<feature>.md and inspect changed files.
Focus on:
- security and permission boundaries
- data integrity and tenant scoping
- edge cases and race conditions
- missing validation and missing tests

Rate findings CRITICAL, WARNING, or INFO.
Include file path and line number.
End with verdict: PASS, CONDITIONAL PASS, or FAIL.
Keep the review read-only.
" --dir /path/to/repo --permission-mode plan
```

## Turn-Aware Loop

Start the job, capture the job id, wait for a turn, then read a bounded capture:

```bash
claude-agent start "Task prompt" --dir /path/to/repo --xhigh --permission-mode plan
claude-agent await-turn <jobId>
claude-agent capture <jobId> 160 --clean
```

Continue the same session when the agent has useful context:

```bash
claude-agent send <jobId> "Adjust the scope: focus on the router and auth boundary. Then continue."
claude-agent await-turn <jobId>
claude-agent capture <jobId> 220 --clean
```

Exit cleanly when done:

```bash
claude-agent send <jobId> "/exit"
```

Use `kill` only when the session is stuck, looping, or actively wrong:

```bash
claude-agent kill <jobId>
```

## Parallel Agents

Spawn parallel Opus agents only when their scopes are independent:

- One agent per module, surface, or variant family.
- Give each agent disjoint ownership if edits are allowed.
- Give editing agents disjoint file ownership.
- Await all turns, then synthesize agreement and contradictions.

Why: parallelism helps when work is independent. It creates merge conflicts and duplicated context burn when scopes overlap.

## Service Mode

Use the service when another CLI or process needs to manage Opus agents without shelling through Codex.

```bash
claude-agent service start --host 127.0.0.1 --port 4877
TOKEN="$(claude-agent service token)"
```

Create a job:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"prompt":"Explore the auth module and report key findings","cwd":"/path/to/repo","effort":"xhigh","permissionMode":"plan"}' \
  http://127.0.0.1:4877/jobs
```

Wait and capture:

```bash
curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:4877/jobs/<jobId>/await-turn?timeoutMs=300000"

curl -sS -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:4877/jobs/<jobId>/capture?lines=160&clean=true"
```

## Context Discipline

- Prefer file paths, PRD paths, maps, briefs, and generated summaries over pasted code.
- Use `--map` for exploration and scoping when `docs/CODEBASE_MAP.md` exists.
- Use implementation prompts without `--map` when the PRD already names exact files; let the agent spend context on source.
- Read `capture --clean` for normal orchestration. Use raw full `output` only when debugging terminal behavior.
- Summarize outputs before reporting to Saint. Quote only the small transcript slices needed for decisions.

Why: the orchestrator's main context is the scarce shared workspace. Agent terminals can hold long transcripts; Codex should pull only the slices needed for decisions.

## Prompt Suffixes

### Research Suffix

```text
---
RESEARCH AGENT INSTRUCTIONS:
- Report facts with file paths and line numbers.
- Group findings by theme.
- Distinguish facts from opinions.
- Keep the run read-only.
- End with Key Findings: 3-5 bullets.
```

### Implementation Suffix

```text
---
IMPLEMENTATION AGENT INSTRUCTIONS:
- Read the PRD/spec before editing.
- Follow existing codebase patterns.
- Keep changes scoped to the requested surface.
- Keep edits scoped to the spec.
- Run typecheck and relevant tests.
- Report changed files and verification results.
```

### Review Suffix

```text
---
REVIEW AGENT INSTRUCTIONS:
- Rate findings CRITICAL, WARNING, or INFO.
- Include file path, line number, and failure scenario.
- Focus on functional issues.
- Keep the review read-only.
- End with verdict: PASS, CONDITIONAL PASS, or FAIL.
```

## Agents Log

For long-running work, maintain `agents.log` in the project root:

```markdown
## Opus Agent: <jobId> - <timestamp>
Type: explore | variant | implement | review
Prompt summary:
Mode: plan | auto
Turn result:
Key findings:
Next action:
```

Why: logs keep multi-agent work recoverable after compaction and make it clear which findings came from which agent.

## Error Recovery

```bash
claude-agent jobs --json
claude-agent status <jobId>
claude-agent capture <jobId> 160 --clean
claude-agent send <jobId> "Status update: what are you blocked on?"
```

If a prompt failed, diagnose the failure and send a sharper follow-up with tighter scope.

## Route Elsewhere

- Use `codex-orchestrator` for pure backend implementation where Codex agents are already the better fit.
- Let Codex handle tiny direct edits that fit safely in the main session.
- Follow Saint's explicit routing when he asks for a specific agent or no agents.
- Keep exploration read-only when Saint asks only for exploration.

Use this skill for Opus specialist leverage. Keep `codex-orchestrator` as the default execution pipeline.
