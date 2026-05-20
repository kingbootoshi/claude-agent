import { homedir } from "node:os";
import { join } from "node:path";

export const reasoningEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];

export const permissionModes = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"] as const;
export type PermissionMode = (typeof permissionModes)[number];

const homeDir = process.env.CLAUDE_AGENT_HOME ?? join(homedir(), ".claude-agent");

export const config = {
  homeDir,
  jobsDir: join(homeDir, "jobs"),
  trashDir: join(homeDir, "trash"),
  serviceTokenFile: join(homeDir, "service-token"),
  defaultModel: process.env.CLAUDE_AGENT_MODEL ?? "opus",
  defaultEffort: (process.env.CLAUDE_AGENT_EFFORT ?? "max") as ReasoningEffort,
  defaultPermissionMode: (process.env.CLAUDE_AGENT_PERMISSION_MODE ?? "auto") as PermissionMode,
  defaultTimeoutMinutes: Number(process.env.CLAUDE_AGENT_TIMEOUT_MINUTES ?? "120"),
  jobsListLimit: Number(process.env.CLAUDE_AGENT_JOBS_LIMIT ?? "20"),
  tmuxPrefix: process.env.CLAUDE_AGENT_TMUX_PREFIX ?? "claude-agent",
  serviceHost: process.env.CLAUDE_AGENT_SERVICE_HOST ?? "127.0.0.1",
  servicePort: Number(process.env.CLAUDE_AGENT_SERVICE_PORT ?? "4877")
};

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (reasoningEfforts as readonly string[]).includes(value);
}

export function isPermissionMode(value: string): value is PermissionMode {
  return (permissionModes as readonly string[]).includes(value);
}

