import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrialRecord } from "./types.ts";

const resultsDir = join(import.meta.dirname, "..", "results");

export function appendEvent(event: Record<string, unknown>): void {
  mkdirSync(resultsDir, { recursive: true });
  appendFileSync(
    join(resultsDir, "journal.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
  );
}

export function appendRun(record: TrialRecord): void {
  mkdirSync(resultsDir, { recursive: true });
  appendFileSync(join(resultsDir, "runs.jsonl"), `${JSON.stringify(record)}\n`);
}

export function readRuns(): TrialRecord[] {
  const file = join(resultsDir, "runs.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TrialRecord);
}
