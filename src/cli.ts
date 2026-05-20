#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { config, isPermissionMode, isReasoningEffort, permissionModes, reasoningEfforts, type PermissionMode, type ReasoningEffort } from "./config.ts";
import { estimateTokens, loadCodebaseMap } from "./files.ts";
import {
  cleanupOldJobs,
  deleteJob,
  getAttachCommand,
  getJobFullOutput,
  getJobOutput,
  getJobsJson,
  getTurnSignal,
  killJob,
  listJobs,
  refreshJobStatus,
  sendToJob,
  startJob,
  type Job,
  type StartJobOptions
} from "./jobs.ts";
import { cleanTerminalOutput } from "./output-cleaner.ts";
import { listSessions, isTmuxAvailable } from "./tmux.ts";
import { readOrCreateServiceToken, rotateServiceToken, startService } from "./service.ts";

interface Options {
  model: string;
  effort: ReasoningEffort;
  permissionMode: PermissionMode;
  cwd: string;
  includeMap: boolean;
  dryRun: boolean;
  wait: boolean;
  clean: boolean;
  json: boolean;
  all: boolean;
  limit: number | null;
  claudePath?: string;
  allowedTools: string[];
  disallowedTools: string[];
  tools: string[];
  addDirs: string[];
  pluginDirs: string[];
  mcpConfigs: string[];
  appendSystemPromptFile?: string;
  dangerouslySkipPermissions: boolean;
  allowDangerouslySkipPermissions: boolean;
  serviceHost: string;
  servicePort: number;
}

const HELP = `Claude Agent - tmux-backed Claude Code agents

Usage:
  claude-agent start "prompt" [options]
  claude-agent status <jobId>
  claude-agent await-turn <jobId>
  claude-agent send <jobId> "message"
  claude-agent capture <jobId> [lines] [--clean]
  claude-agent output <jobId> [--clean]
  claude-agent jobs [--json] [--all]
  claude-agent sessions
  claude-agent attach <jobId>
  claude-agent watch <jobId>
  claude-agent kill <jobId>
  claude-agent clean
  claude-agent health
  claude-agent auth <status|login|setup-token>
  claude-agent service <start|token|rotate-token>

Defaults:
  model: ${config.defaultModel}
  effort: ${config.defaultEffort}
  permission mode: ${config.defaultPermissionMode}

Options:
  -m, --model <model>              Claude Code model alias or full name
  -e, --effort <level>             ${reasoningEfforts.join(", ")}
  --max                            Shortcut for --effort max
  --xhigh                          Shortcut for --effort xhigh
  --permission-mode <mode>         ${permissionModes.join(", ")}
  --auto                           Shortcut for --permission-mode auto
  --bypass                         Shortcut for bypassPermissions plus --dangerously-skip-permissions
  -d, --dir <path>                 Working directory
  --map                            Inject docs/CODEBASE_MAP.md when present
  --claude-path <path>             Claude executable override
  --allowed-tools <tools>          Repeatable Claude --allowedTools
  --disallowed-tools <tools>       Repeatable Claude --disallowedTools
  --tools <tools>                  Repeatable Claude --tools
  --add-dir <path>                 Repeatable Claude --add-dir
  --plugin-dir <path>              Repeatable Claude --plugin-dir
  --mcp-config <path-or-json>      Repeatable Claude --mcp-config
  --append-system-prompt-file <p>  Claude --append-system-prompt-file
  --wait                           Wait for the first turn signal
  --dry-run                        Print launch summary only
`;

function parseArgs(args: string[]): { command: string; positional: string[]; options: Options } {
  const options: Options = {
    model: config.defaultModel,
    effort: config.defaultEffort,
    permissionMode: config.defaultPermissionMode,
    cwd: process.cwd(),
    includeMap: false,
    dryRun: false,
    wait: false,
    clean: false,
    json: false,
    all: false,
    limit: config.jobsListLimit,
    allowedTools: [],
    disallowedTools: [],
    tools: [],
    addDirs: [],
    pluginDirs: [],
    mcpConfigs: [],
    dangerouslySkipPermissions: false,
    allowDangerouslySkipPermissions: false,
    serviceHost: config.serviceHost,
    servicePort: config.servicePort
  };
  const positional: string[] = [];
  let command = "";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    const next = () => args[++i] ?? "";
    if (arg === "-h" || arg === "--help") {
      console.log(HELP);
      process.exit(0);
    } else if (arg === "-m" || arg === "--model") {
      options.model = next();
    } else if (arg === "-e" || arg === "--effort") {
      const effort = next();
      if (!isReasoningEffort(effort)) fail(`invalid effort: ${effort}`);
      options.effort = effort;
    } else if (arg === "--max") {
      options.effort = "max";
    } else if (arg === "--xhigh") {
      options.effort = "xhigh";
    } else if (arg === "--permission-mode") {
      const mode = next();
      if (!isPermissionMode(mode)) fail(`invalid permission mode: ${mode}`);
      options.permissionMode = mode;
    } else if (arg === "--auto") {
      options.permissionMode = "auto";
    } else if (arg === "--bypass") {
      options.permissionMode = "bypassPermissions";
      options.dangerouslySkipPermissions = true;
    } else if (arg === "--dangerously-skip-permissions") {
      options.dangerouslySkipPermissions = true;
    } else if (arg === "--allow-dangerously-skip-permissions") {
      options.allowDangerouslySkipPermissions = true;
    } else if (arg === "-d" || arg === "--dir") {
      options.cwd = next();
    } else if (arg === "--map") {
      options.includeMap = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--wait" || arg === "-w") {
      options.wait = true;
    } else if (arg === "--clean" || arg === "--strip-ansi") {
      options.clean = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--limit") {
      options.limit = Number(next());
    } else if (arg === "--claude-path") {
      options.claudePath = next();
    } else if (arg === "--allowed-tools" || arg === "--allowedTools") {
      options.allowedTools.push(next());
    } else if (arg === "--disallowed-tools" || arg === "--disallowedTools") {
      options.disallowedTools.push(next());
    } else if (arg === "--tools") {
      options.tools.push(next());
    } else if (arg === "--add-dir") {
      options.addDirs.push(next());
    } else if (arg === "--plugin-dir") {
      options.pluginDirs.push(next());
    } else if (arg === "--mcp-config") {
      options.mcpConfigs.push(next());
    } else if (arg === "--append-system-prompt-file") {
      options.appendSystemPromptFile = next();
    } else if (arg === "--host") {
      options.serviceHost = next();
    } else if (arg === "--port") {
      options.servicePort = Number(next());
    } else if (arg.startsWith("-")) {
      fail(`unknown option: ${arg}`);
    } else if (!command) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, options };
}

async function main() {
  const { command, positional, options } = parseArgs(Bun.argv.slice(2));
  if (!command) {
    console.log(HELP);
    return 0;
  }
  switch (command) {
    case "start":
      return await startCommand(positional, options);
    case "status":
      return statusCommand(positional);
    case "await-turn":
      return await awaitTurnCommand(positional);
    case "send":
      return sendCommand(positional);
    case "capture":
      return captureCommand(positional, options);
    case "output":
      return outputCommand(positional, options);
    case "jobs":
      return jobsCommand(options);
    case "sessions":
      return sessionsCommand();
    case "attach":
      return attachCommand(positional);
    case "watch":
      return await watchCommand(positional, options);
    case "kill":
      return controlCommand(positional, killJob, "Killed");
    case "delete":
      return controlCommand(positional, deleteJob, "Archived");
    case "clean":
      return cleanCommand();
    case "health":
      return healthCommand();
    case "auth":
      return authCommand(positional);
    case "service":
      return await serviceCommand(positional, options);
    default:
      return await startCommand([command, ...positional], options);
  }
}

async function startCommand(positional: string[], options: Options): Promise<number> {
  if (positional.length === 0) fail("no prompt provided");
  if (!isTmuxAvailable()) fail("tmux is required but was not found");
  let prompt = positional.join(" ");
  if (options.includeMap) {
    const map = loadCodebaseMap(options.cwd);
    if (map) prompt = `## Codebase Map\n\n${map}\n\n---\n\n${prompt}`;
  }
  if (options.dryRun) {
    console.log(`Would send approximately ${estimateTokens(prompt).toLocaleString()} tokens`);
    console.log(`Model: ${options.model}`);
    console.log(`Effort: ${options.effort}`);
    console.log(`Permission mode: ${options.permissionMode}`);
    console.log(`Working dir: ${options.cwd}`);
    console.log("\n--- Prompt Preview ---\n");
    console.log(prompt.slice(0, 3000));
    return 0;
  }
  const startOptions: StartJobOptions = {
    prompt,
    cwd: options.cwd,
    model: options.model,
    effort: options.effort,
    permissionMode: options.permissionMode,
    ...(options.claudePath === undefined ? {} : { claudePath: options.claudePath }),
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    tools: options.tools,
    addDirs: options.addDirs,
    pluginDirs: options.pluginDirs,
    mcpConfigs: options.mcpConfigs,
    ...(options.appendSystemPromptFile === undefined ? {} : { appendSystemPromptFile: options.appendSystemPromptFile }),
    dangerouslySkipPermissions: options.dangerouslySkipPermissions,
    allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions
  };
  const job = startJob(startOptions);
  console.log(`Job started: ${job.id}`);
  console.log(`Model: ${job.model}`);
  console.log(`Effort: ${job.effort}`);
  console.log(`Permission mode: ${job.permissionMode}`);
  console.log(`Working dir: ${job.cwd}`);
  console.log(`tmux session: ${job.tmuxSession}`);
  console.log(`Capture: claude-agent capture ${job.id} --clean`);
  console.log(`Send: claude-agent send ${job.id} "message"`);
  if (options.wait) return await awaitTurnCommand([job.id]);
  return job.status === "running" ? 0 : 1;
}

function statusCommand(positional: string[]): number {
  const id = requiredJobId(positional);
  const job = refreshJobStatus(id);
  if (!job) fail(`job not found: ${id}`);
  console.log(`Job: ${job.id}`);
  console.log(`Status: ${job.status}`);
  console.log(`Model: ${job.model}`);
  console.log(`Effort: ${job.effort}`);
  console.log(`Permission mode: ${job.permissionMode}`);
  console.log(`Cwd: ${job.cwd}`);
  if (job.tmuxSession) console.log(`tmux session: ${job.tmuxSession}`);
  if (job.turnState) console.log(`Turn state: ${job.turnState}`);
  console.log(`Turns completed: ${job.turnCount ?? 0}`);
  if (job.lastTurnCompletedAt) console.log(`Last turn: ${job.lastTurnCompletedAt}`);
  if (job.lastAgentMessage) console.log(`Last message: ${job.lastAgentMessage}`);
  if (job.error) console.log(`Error: ${job.error}`);
  return 0;
}

async function awaitTurnCommand(positional: string[]): Promise<number> {
  const id = requiredJobId(positional);
  const started = Date.now();
  while (Date.now() - started < 12 * 60 * 60_000) {
    const signal = getTurnSignal(id);
    if (signal) {
      console.log(signal.lastAgentMessage ?? "Turn complete");
      return 0;
    }
    const job = refreshJobStatus(id);
    if (!job) fail(`job not found: ${id}`);
    if (job.status !== "running") {
      console.log(`Job ended: ${job.status}`);
      return job.status === "completed" ? 0 : 1;
    }
    await Bun.sleep(500);
  }
  fail("timed out waiting for turn");
}

function sendCommand(positional: string[]): number {
  const id = requiredJobId(positional);
  const message = positional.slice(1).join(" ");
  if (!message) fail("message is required");
  if (!sendToJob(id, message)) fail(`could not send to job ${id}`);
  console.log(`Sent to ${id}: ${message}`);
  return 0;
}

function captureCommand(positional: string[], options: Options): number {
  const id = requiredJobId(positional);
  const lines = positional[1] ? Number(positional[1]) : 80;
  const output = getJobOutput(id, Number.isFinite(lines) ? lines : 80);
  if (output === null) fail(`could not capture output for ${id}`);
  console.log(options.clean ? cleanTerminalOutput(output) : output);
  return 0;
}

function outputCommand(positional: string[], options: Options): number {
  const id = requiredJobId(positional);
  const output = getJobFullOutput(id);
  if (output === null) fail(`could not read output for ${id}`);
  console.log(options.clean ? cleanTerminalOutput(output) : output);
  return 0;
}

function jobsCommand(options: Options): number {
  if (options.json) {
    console.log(JSON.stringify(getJobsJson({ all: options.all, limit: options.limit }), null, 2));
    return 0;
  }
  const jobs = sortJobs(listJobs({ all: options.all, limit: options.limit }));
  if (jobs.length === 0) {
    console.log("No jobs");
    return 0;
  }
  console.log("ID        STATUS      ELAPSED   EFFORT  PROMPT");
  console.log("-".repeat(86));
  for (const job of jobs) console.log(formatJob(job));
  return 0;
}

function sessionsCommand(): number {
  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log("No active claude-agent sessions");
    return 0;
  }
  for (const session of sessions) console.log(`${session.name}\tattached=${session.attached ? "yes" : "no"}\t${session.created}`);
  return 0;
}

function attachCommand(positional: string[]): number {
  const id = requiredJobId(positional);
  const command = getAttachCommand(id);
  if (!command) fail(`job not found or has no tmux session: ${id}`);
  console.log(command);
  return 0;
}

async function watchCommand(positional: string[], options: Options): Promise<number> {
  const id = requiredJobId(positional);
  let previous = "";
  while (true) {
    const output = getJobOutput(id, 120);
    if (output && output !== previous) {
      const visible = options.clean ? cleanTerminalOutput(output) : output;
      console.clear();
      console.log(visible);
      previous = output;
    }
    const job = refreshJobStatus(id);
    if (!job || job.status !== "running") return 0;
    await Bun.sleep(1000);
  }
}

function controlCommand(positional: string[], fn: (id: string) => boolean, verb: string): number {
  const id = requiredJobId(positional);
  if (!fn(id)) fail(`could not control job: ${id}`);
  console.log(`${verb} job: ${id}`);
  return 0;
}

function cleanCommand(): number {
  const result = cleanupOldJobs(7);
  console.log(`Archived ${result.jobsArchived} old jobs and killed ${result.orphanedSessionsKilled} orphaned tmux sessions`);
  return 0;
}

function healthCommand(): number {
  const tmux = spawnSync("tmux", ["-V"], { encoding: "utf8", timeout: 5_000 });
  console.log(tmux.status === 0 ? `tmux: ${tmux.stdout.trim()}` : "tmux: missing");
  const claude = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 5_000 });
  console.log(claude.status === 0 ? `claude: ${claude.stdout.trim()}` : "claude: missing");
  const auth = spawnSync("claude", ["auth", "status"], { encoding: "utf8", timeout: 5_000 });
  if (auth.error) console.log(`auth: status check timed out or failed (${auth.error.message})`);
  else if (auth.stdout.trim()) console.log(`auth: ${auth.stdout.trim()}`);
  return tmux.status === 0 && claude.status === 0 ? 0 : 1;
}

function authCommand(positional: string[]): number {
  const subcommand = positional[0] ?? "status";
  const args = subcommand === "setup-token" ? ["setup-token"] : ["auth", subcommand];
  const result = spawnSync("claude", args, { stdio: "inherit" });
  return result.status ?? 1;
}

async function serviceCommand(positional: string[], options: Options): Promise<number> {
  const subcommand = positional[0] ?? "start";
  if (subcommand === "token") {
    console.log(readOrCreateServiceToken());
    return 0;
  }
  if (subcommand === "rotate-token") {
    console.log(rotateServiceToken());
    return 0;
  }
  if (subcommand !== "start") fail("usage: claude-agent service <start|token|rotate-token>");
  const server = startService({ host: options.serviceHost, port: options.servicePort });
  console.log(`claude-agent service listening on http://${server.hostname}:${server.port}`);
  console.log(`Bearer token file: ${config.serviceTokenFile}`);
  await new Promise(() => undefined);
  return 0;
}

function requiredJobId(positional: string[]): string {
  const id = positional[0];
  if (!id) fail("job id is required");
  return id;
}

function sortJobs(jobs: Job[]): Job[] {
  const rank: Record<Job["status"], number> = { running: 0, pending: 1, failed: 2, completed: 3 };
  return [...jobs].sort((a, b) => rank[a.status] - rank[b.status] || Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function formatJob(job: Job): string {
  const elapsed = formatDuration(elapsedMs(job));
  const prompt = job.prompt.length > 54 ? `${job.prompt.slice(0, 54)}...` : job.prompt;
  return `${job.id}  ${job.status.toUpperCase().padEnd(10)}  ${elapsed.padEnd(8)}  ${job.effort.padEnd(6)}  ${prompt}`;
}

function elapsedMs(job: Job): number {
  const start = Date.parse(job.startedAt ?? job.createdAt);
  const end = Date.parse(job.completedAt ?? new Date().toISOString());
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const exitCode = await main().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  return 1;
});
process.exit(exitCode);
