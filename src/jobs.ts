import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { config, type PermissionMode, type ReasoningEffort } from "./config.ts";
import { clearSignalFile, readSignalFile, signalFileExists } from "./watcher.ts";
import {
  capturePane,
  createSession,
  getSessionName,
  killSession,
  sessionExists,
  sendMessage
} from "./tmux.ts";
import { shellQuote } from "./shell.ts";

export interface Job {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  prompt: string;
  model: string;
  effort: ReasoningEffort;
  permissionMode: PermissionMode;
  cwd: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  tmuxSession?: string;
  claudeSessionId?: string;
  result?: string;
  error?: string;
  turnCount?: number;
  lastTurnCompletedAt?: string;
  lastAgentMessage?: string;
  turnState?: "working" | "idle" | "context_limit";
}

export interface StartJobOptions {
  prompt: string;
  cwd?: string;
  model?: string;
  effort?: ReasoningEffort;
  permissionMode?: PermissionMode;
  claudePath?: string;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  tools?: readonly string[];
  addDirs?: readonly string[];
  pluginDirs?: readonly string[];
  mcpConfigs?: readonly string[];
  appendSystemPromptFile?: string;
  dangerouslySkipPermissions?: boolean;
  allowDangerouslySkipPermissions?: boolean;
  env?: Record<string, string>;
}

export interface LaunchSpec {
  jobId: string;
  claudePath: string;
  args: string[];
  cwd: string;
  promptFile: string;
  sessionName: string;
  env?: Record<string, string>;
}

export interface JobsJsonOutput {
  generated_at: string;
  jobs: Array<{
    id: string;
    status: Job["status"];
    prompt: string;
    model: string;
    effort: ReasoningEffort;
    permission_mode: PermissionMode;
    cwd: string;
    elapsed_ms: number;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
    turn_state: Job["turnState"] | null;
    turns_completed: number;
    last_message: string | null;
  }>;
}

export function ensureJobsDir(): void {
  mkdirSync(config.jobsDir, { recursive: true });
}

function ensureTrashDir(): void {
  mkdirSync(config.trashDir, { recursive: true });
}

function jobPath(jobId: string): string {
  return join(config.jobsDir, `${jobId}.json`);
}

function launchPath(jobId: string): string {
  return join(config.jobsDir, `${jobId}.launch.json`);
}

function logPath(jobId: string): string {
  return join(config.jobsDir, `${jobId}.log`);
}

function promptPath(jobId: string): string {
  return join(config.jobsDir, `${jobId}.prompt`);
}

function settingsPath(jobId: string): string {
  return join(config.jobsDir, `${jobId}.settings.json`);
}

function generateJobId(): string {
  return randomBytes(4).toString("hex");
}

export function saveJob(job: Job): void {
  ensureJobsDir();
  writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2));
}

export function loadJob(jobId: string): Job | null {
  try {
    return JSON.parse(readFileSync(jobPath(jobId), "utf8")) as Job;
  } catch {
    return null;
  }
}

export function loadLaunchSpec(jobId: string): LaunchSpec {
  return JSON.parse(readFileSync(launchPath(jobId), "utf8")) as LaunchSpec;
}

export function listJobs(options: { all?: boolean; limit?: number | null } = {}): Job[] {
  ensureJobsDir();
  const jobs = readdirSync(config.jobsDir)
    .filter((file) => file.endsWith(".json") && !file.includes(".settings") && !file.includes(".launch"))
    .map((file) => loadJob(file.slice(0, -5)))
    .filter((job): job is Job => job !== null)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (options.all) return jobs;
  const active = jobs.filter((job) => job.status === "running" || job.status === "pending");
  const activeIds = new Set(active.map((job) => job.id));
  const recent = jobs.filter((job) => !activeIds.has(job.id)).slice(0, Math.max((options.limit ?? config.jobsListLimit) - active.length, 0));
  return [...active, ...recent];
}

export function startJob(options: StartJobOptions): Job {
  ensureJobsDir();
  const id = generateJobId();
  const cwd = resolve(options.cwd ?? process.cwd());
  const tmuxSession = getSessionName(id);
  const model = options.model ?? config.defaultModel;
  const effort = options.effort ?? config.defaultEffort;
  const permissionMode = options.permissionMode ?? config.defaultPermissionMode;
  const promptFile = promptPath(id);
  const settingsFile = settingsPath(id);
  const launcherPath = join(import.meta.dir, "launch-claude-session.ts");
  const hookPath = join(import.meta.dir, "turn-hook.ts");

  const job: Job = {
    id,
    status: "pending",
    prompt: options.prompt,
    model,
    effort,
    permissionMode,
    cwd,
    createdAt: new Date().toISOString(),
    tmuxSession,
    turnState: "working",
    turnCount: 0
  };
  saveJob(job);
  writeFileSync(promptFile, options.prompt);
  writeSettingsFile(settingsFile, id, hookPath);
  writeLaunchSpec(id, {
    jobId: id,
    claudePath: options.claudePath ?? process.env.CLAUDE_AGENT_CLAUDE_PATH ?? "claude",
    args: buildClaudeArgs({
      model,
      effort,
      permissionMode,
      settingsFile,
      jobId: id,
      ...options
    }),
    cwd,
    promptFile,
    sessionName: tmuxSession,
    ...(options.env === undefined ? {} : { env: options.env })
  });

  const created = createSession({ jobId: id, cwd, logFile: logPath(id), launcherPath });
  if (!created.success) {
    job.status = "failed";
    job.error = created.error ?? "failed to create tmux session";
    job.completedAt = new Date().toISOString();
  } else {
    job.status = "running";
    job.startedAt = new Date().toISOString();
  }
  saveJob(job);
  return job;
}

function writeLaunchSpec(jobId: string, spec: LaunchSpec): void {
  writeFileSync(launchPath(jobId), JSON.stringify(spec, null, 2));
}

function hookCommand(hookPath: string, jobId: string, event: "Stop" | "StopFailure"): string {
  const envPrefix = process.env.CLAUDE_AGENT_HOME === undefined ? "" : `CLAUDE_AGENT_HOME=${shellQuote(config.homeDir)} `;
  return `${envPrefix}bun ${shellQuote(hookPath)} ${shellQuote(jobId)} ${event}`;
}

function writeSettingsFile(path: string, jobId: string, hookPath: string): void {
  const settings = {
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: hookCommand(hookPath, jobId, "Stop") }] }],
      StopFailure: [{ matcher: "", hooks: [{ type: "command", command: hookCommand(hookPath, jobId, "StopFailure") }] }]
    }
  };
  writeFileSync(path, JSON.stringify(settings, null, 2));
}

function appendRepeated(args: string[], flag: string, values: readonly string[] | undefined): void {
  for (const value of values ?? []) args.push(flag, value);
}

function buildClaudeArgs(input: StartJobOptions & {
  jobId: string;
  model: string;
  effort: ReasoningEffort;
  permissionMode: PermissionMode;
  settingsFile: string;
}): string[] {
  const args = [
    "--model",
    input.model,
    "--effort",
    input.effort,
    "--permission-mode",
    input.dangerouslySkipPermissions === true ? "bypassPermissions" : input.permissionMode,
    "--settings",
    input.settingsFile,
    "--name",
    `claude-agent-${input.jobId}`
  ];
  if (input.dangerouslySkipPermissions === true) args.push("--dangerously-skip-permissions");
  if (input.allowDangerouslySkipPermissions === true) args.push("--allow-dangerously-skip-permissions");
  if (input.appendSystemPromptFile !== undefined) args.push("--append-system-prompt-file", input.appendSystemPromptFile);
  appendRepeated(args, "--allowedTools", input.allowedTools);
  appendRepeated(args, "--disallowedTools", input.disallowedTools);
  appendRepeated(args, "--tools", input.tools);
  appendRepeated(args, "--add-dir", input.addDirs);
  appendRepeated(args, "--plugin-dir", input.pluginDirs);
  appendRepeated(args, "--mcp-config", input.mcpConfigs);
  return args;
}

export function refreshJobStatus(jobId: string): Job | null {
  const job = loadJob(jobId);
  if (!job) return null;
  if ((job.status === "pending" || job.status === "running") && job.tmuxSession && !sessionExists(job.tmuxSession)) {
    const fromDisk = loadJob(jobId) ?? job;
    if (fromDisk.status === "pending" || fromDisk.status === "running") {
      fromDisk.status = "completed";
      fromDisk.completedAt = new Date().toISOString();
      fromDisk.turnState = "idle";
      try {
        fromDisk.result = readFileSync(logPath(jobId), "utf8");
      } catch {
        // Log capture is best effort.
      }
      saveJob(fromDisk);
    }
    return loadJob(jobId);
  }
  if (job.status === "running" && isInactiveTimedOut(job)) {
    if (job.tmuxSession) killSession(job.tmuxSession);
    job.status = "failed";
    job.error = `Timed out after ${config.defaultTimeoutMinutes} minutes of inactivity`;
    job.completedAt = new Date().toISOString();
    job.turnState = "idle";
    saveJob(job);
  }
  return loadJob(jobId);
}

function isInactiveTimedOut(job: Job): boolean {
  if (!Number.isFinite(config.defaultTimeoutMinutes) || config.defaultTimeoutMinutes <= 0) return false;
  const mtime = safeMtime(logPath(job.id));
  const fallback = Date.parse(job.startedAt ?? job.createdAt);
  const last = mtime ?? (Number.isFinite(fallback) ? fallback : Date.now());
  return Date.now() - last > config.defaultTimeoutMinutes * 60_000;
}

function safeMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export function markTurnComplete(jobId: string, patch: Partial<Job>): void {
  const job = loadJob(jobId);
  if (!job) return;
  job.turnCount = (job.turnCount ?? 0) + 1;
  job.lastTurnCompletedAt = new Date().toISOString();
  job.turnState = "idle";
  if (patch.claudeSessionId !== undefined) job.claudeSessionId = patch.claudeSessionId;
  if (patch.lastAgentMessage !== undefined) job.lastAgentMessage = patch.lastAgentMessage;
  if (patch.error !== undefined) job.error = patch.error;
  saveJob(job);
}

export function markJobExited(jobId: string, exitCode: number, error?: string): void {
  const job = loadJob(jobId);
  if (!job) return;
  if (job.status === "running" || job.status === "pending") {
    job.status = exitCode === 0 ? "completed" : "failed";
    job.completedAt = new Date().toISOString();
    job.turnState = "idle";
    if (error !== undefined) job.error = error;
    try {
      job.result = readFileSync(logPath(jobId), "utf8");
    } catch {
      // Log capture is best effort.
    }
    saveJob(job);
  }
}

export function sendToJob(jobId: string, message: string): boolean {
  const job = refreshJobStatus(jobId);
  if (!job || job.status !== "running" || !job.tmuxSession) return false;
  const sent = sendMessage(job.tmuxSession, message);
  if (!sent) return false;
  clearSignalFile(jobId);
  job.turnState = "working";
  saveJob(job);
  return true;
}

export function killJob(jobId: string): boolean {
  const job = loadJob(jobId);
  if (!job) return false;
  if (job.tmuxSession && sessionExists(job.tmuxSession)) killSession(job.tmuxSession);
  job.status = "failed";
  job.error = "Killed by user";
  job.completedAt = new Date().toISOString();
  job.turnState = "idle";
  saveJob(job);
  return true;
}

export function getJobOutput(jobId: string, lines?: number): string | null {
  const job = loadJob(jobId);
  if (!job) return null;
  if (job.tmuxSession && sessionExists(job.tmuxSession)) {
    const pane = capturePane(job.tmuxSession, lines);
    if (pane !== null) return pane;
  }
  try {
    const content = readFileSync(logPath(jobId), "utf8");
    return lines === undefined ? content : content.split("\n").slice(-lines).join("\n");
  } catch {
    return null;
  }
}

export function getJobFullOutput(jobId: string): string | null {
  return getJobOutput(jobId);
}

export function isJobIdle(jobId: string): boolean {
  return signalFileExists(jobId);
}

export function getTurnSignal(jobId: string) {
  return readSignalFile(jobId);
}

export function getAttachCommand(jobId: string): string | null {
  const job = loadJob(jobId);
  if (!job?.tmuxSession) return null;
  return `tmux attach -t ${shellQuote(job.tmuxSession)}`;
}

export function deleteJob(jobId: string): boolean {
  const job = loadJob(jobId);
  if (job?.tmuxSession && sessionExists(job.tmuxSession)) killSession(job.tmuxSession);
  ensureTrashDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const targetDir = join(config.trashDir, `${jobId}-${stamp}`);
  mkdirSync(targetDir, { recursive: true });
  let moved = false;
  for (const suffix of [".json", ".launch.json", ".settings.json", ".prompt", ".log", ".turn-complete.json", ".turn-previous.json"]) {
    const path = join(config.jobsDir, `${jobId}${suffix}`);
    if (!existsSync(path)) continue;
    renameSync(path, join(targetDir, `${jobId}${suffix}`));
    moved = true;
  }
  return moved;
}

export function cleanupOldJobs(maxAgeDays = 7): { jobsArchived: number; orphanedSessionsKilled: number } {
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  let jobsArchived = 0;
  for (const job of listJobs({ all: true })) {
    const time = Date.parse(job.completedAt ?? job.createdAt);
    if (Number.isFinite(time) && time < cutoff && (job.status === "completed" || job.status === "failed")) {
      if (deleteJob(job.id)) jobsArchived += 1;
    }
  }
  return { jobsArchived, orphanedSessionsKilled: 0 };
}

export function getJobsJson(options: { all?: boolean; limit?: number | null } = {}): JobsJsonOutput {
  return {
    generated_at: new Date().toISOString(),
    jobs: listJobs(options).map((job) => {
      const refreshed = job.status === "running" || job.status === "pending" ? refreshJobStatus(job.id) ?? job : job;
      return {
        id: refreshed.id,
        status: refreshed.status,
        prompt: refreshed.prompt.length > 160 ? `${refreshed.prompt.slice(0, 160)}...` : refreshed.prompt,
        model: refreshed.model,
        effort: refreshed.effort,
        permission_mode: refreshed.permissionMode,
        cwd: refreshed.cwd,
        elapsed_ms: elapsedMs(refreshed),
        created_at: refreshed.createdAt,
        started_at: refreshed.startedAt ?? null,
        completed_at: refreshed.completedAt ?? null,
        turn_state: refreshed.turnState ?? null,
        turns_completed: refreshed.turnCount ?? 0,
        last_message: refreshed.lastAgentMessage ?? null
      };
    })
  };
}

function elapsedMs(job: Job): number {
  const start = Date.parse(job.startedAt ?? job.createdAt);
  const end = Date.parse(job.completedAt ?? new Date().toISOString());
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

export function ensureParentDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}
