#!/usr/bin/env bun

import { markTurnComplete } from "./jobs.ts";
import { writeSignalFile, type TurnEvent } from "./watcher.ts";

const jobId = process.argv[2];
const event = process.argv[3] === "StopFailure" ? "StopFailure" : "Stop";

if (!jobId) process.exit(0);

const input = await new Response(Bun.stdin.stream()).text().catch(() => "");
let payload: Record<string, unknown> = {};
try {
  payload = input.trim() ? (JSON.parse(input) as Record<string, unknown>) : {};
} catch {
  payload = {};
}

const signal: TurnEvent = {
  event,
  jobId,
  timestamp: new Date().toISOString(),
  ...stringField("sessionId", payload, "session_id"),
  ...stringField("cwd", payload, "cwd"),
  ...stringField("transcriptPath", payload, "transcript_path"),
  ...stringField("permissionMode", payload, "permission_mode"),
  ...stringField("model", payload, "model"),
  ...stringField("effort", payload, "effort"),
  lastAgentMessage: event === "Stop" ? "Claude turn complete" : "Claude turn ended with an API error"
};

writeSignalFile(signal);
markTurnComplete(jobId, {
  claudeSessionId: signal.sessionId,
  lastAgentMessage: signal.lastAgentMessage,
  ...(event === "StopFailure" ? { error: signal.lastAgentMessage } : {})
});

function stringField(target: string, payload: Record<string, unknown>, source: string): Record<string, string> {
  const value = payload[source];
  return typeof value === "string" && value.length > 0 ? { [target]: value } : {};
}

