#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { loadLaunchSpec, markJobExited } from "./jobs.ts";

const jobId = process.argv[2];
if (!jobId) process.exit(1);

let exitCode = 1;
let errorMessage: string | undefined;

try {
  const spec = loadLaunchSpec(jobId);
  const prompt = readFileSync(spec.promptFile, "utf8");
  const proc = Bun.spawn([spec.claudePath, ...spec.args, prompt], {
    cwd: spec.cwd,
    env: { ...Bun.env, ...(spec.env ?? {}) },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  });
  exitCode = await proc.exited;
} catch (cause) {
  errorMessage = cause instanceof Error ? cause.message : String(cause);
  console.error(`claude-agent launch failed: ${errorMessage}`);
}

markJobExited(jobId, exitCode, errorMessage);
console.log(`\n\n[claude-agent: Session complete with exit code ${exitCode}. Closing in 5s.]`);
await Bun.sleep(5000);

process.exit(exitCode);
