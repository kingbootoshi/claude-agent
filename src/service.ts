import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { config, isPermissionMode, isReasoningEffort } from "./config.ts";
import {
  getJobFullOutput,
  getJobOutput,
  getJobsJson,
  getTurnSignal,
  killJob,
  refreshJobStatus,
  sendToJob,
  startJob,
  type StartJobOptions
} from "./jobs.ts";
import { cleanTerminalOutput } from "./output-cleaner.ts";

export interface ServiceOptions {
  host?: string;
  port?: number;
  token?: string;
}

export function readOrCreateServiceToken(): string {
  if (existsSync(config.serviceTokenFile)) return readFileSync(config.serviceTokenFile, "utf8").trim();
  const token = `claude_agent_${randomBytes(32).toString("hex")}`;
  mkdirSync(dirname(config.serviceTokenFile), { recursive: true });
  const temp = `${config.serviceTokenFile}.${process.pid}.tmp`;
  writeFileSync(temp, `${token}\n`, { mode: 0o600 });
  renameSync(temp, config.serviceTokenFile);
  return token;
}

export function rotateServiceToken(): string {
  const token = `claude_agent_${randomBytes(32).toString("hex")}`;
  mkdirSync(dirname(config.serviceTokenFile), { recursive: true });
  const temp = `${config.serviceTokenFile}.${process.pid}.tmp`;
  writeFileSync(temp, `${token}\n`, { mode: 0o600 });
  renameSync(temp, config.serviceTokenFile);
  return token;
}

export function startService(options: ServiceOptions = {}) {
  const host = options.host ?? config.serviceHost;
  const port = options.port ?? config.servicePort;
  const token = options.token ?? readOrCreateServiceToken();
  const server = Bun.serve({
    hostname: host,
    port,
    async fetch(request) {
      try {
        const url = new URL(request.url);
        if (url.pathname === "/health") return json({ ok: true, service: "claude-agent" });
        if (!authorized(request, token)) return json({ ok: false, error: "unauthorized" }, 401);
        return await route(request, url);
      } catch (cause) {
        return json({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }, 500);
      }
    }
  });
  return server;
}

async function route(request: Request, url: URL): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/jobs") {
    return json(getJobsJson({ all: url.searchParams.get("all") === "true" }));
  }
  if (request.method === "POST" && url.pathname === "/jobs") {
    const body = await request.json();
    const options = startOptionsFromBody(body);
    const job = startJob(options);
    return json({ ok: job.status === "running", job }, job.status === "running" ? 202 : 500);
  }
  const match = /^\/jobs\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) return json({ ok: false, error: "not found" }, 404);
  const jobId = match[1] ?? "";
  const action = match[2] ?? "status";
  if (request.method === "GET" && action === "status") return json({ ok: true, job: refreshJobStatus(jobId) });
  if (request.method === "GET" && action === "capture") {
    const lines = numberParam(url.searchParams.get("lines"));
    const output = getJobOutput(jobId, lines);
    return json({ ok: output !== null, output: maybeClean(output, url) });
  }
  if (request.method === "GET" && action === "output") {
    const output = getJobFullOutput(jobId);
    return json({ ok: output !== null, output: maybeClean(output, url) });
  }
  if (request.method === "POST" && action === "send") {
    const body = await request.json();
    const message = typeof body?.message === "string" ? body.message : "";
    return json({ ok: message.length > 0 && sendToJob(jobId, message) });
  }
  if (request.method === "POST" && action === "kill") return json({ ok: killJob(jobId) });
  if (request.method === "POST" && action === "await-turn") {
    const timeoutMs = numberParam(url.searchParams.get("timeoutMs")) ?? 300_000;
    const signal = await waitForTurn(jobId, timeoutMs);
    return json({ ok: signal !== null, signal }, signal === null ? 408 : 200);
  }
  return json({ ok: false, error: "not found" }, 404);
}

function startOptionsFromBody(body: unknown): StartJobOptions {
  if (body === null || typeof body !== "object") throw new Error("request body must be an object");
  const record = body as Record<string, unknown>;
  const prompt = stringField(record, "prompt");
  if (prompt === undefined || prompt.trim().length === 0) throw new Error("prompt is required");
  const effort = stringField(record, "effort");
  const permissionMode = stringField(record, "permissionMode");
  return {
    prompt,
    ...optionalString(record, "cwd"),
    ...optionalString(record, "model"),
    ...(effort !== undefined && isReasoningEffort(effort) ? { effort } : {}),
    ...(permissionMode !== undefined && isPermissionMode(permissionMode) ? { permissionMode } : {}),
    ...optionalString(record, "claudePath")
  };
}

function optionalString(record: Record<string, unknown>, key: string): Record<string, string> {
  const value = stringField(record, key);
  return value === undefined ? {} : { [key]: value };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberParam(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function maybeClean(output: string | null, url: URL): string | null {
  if (output === null) return null;
  return url.searchParams.get("clean") === "true" ? cleanTerminalOutput(output) : output;
}

async function waitForTurn(jobId: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const signal = getTurnSignal(jobId);
    if (signal !== null) return signal;
    const job = refreshJobStatus(jobId);
    if (!job || job.status !== "running") return getTurnSignal(jobId);
    await Bun.sleep(500);
  }
  return null;
}

function authorized(request: Request, expected: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });
}

