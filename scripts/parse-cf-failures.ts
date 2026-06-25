#!/usr/bin/env bun
/**
 * Parse a vitest JSON report (+ console log fallback) into a flat list of
 * failed tests: file, test name, error. Throwaway helper for
 * test-with-temporary-account.ts runs.
 *
 *   bun scripts/parse-cf-failures.ts <results.json> <console.log> <out.txt>
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , jsonPath, logPath, outPath] = process.argv;
if (!jsonPath || !outPath) {
  console.error(
    "usage: bun scripts/parse-cf-failures.ts <results.json> <console.log> <out.txt>",
  );
  process.exit(1);
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const relFile = (name: string): string => {
  const norm = name.replaceAll("\\", "/");
  const i = norm.indexOf("packages/alchemy/");
  return i >= 0 ? norm.slice(i + "packages/alchemy/".length) : norm;
};

// First meaningful line of a failure message (the bit before the stack trace).
const firstErrorLine = (msg: string): string => {
  for (const raw of msg.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (/^\s*(❯|at )/.test(line)) break;
    return line.trim();
  }
  return "";
};

// Build a name -> error map from the console log, for STACK_TRACE_ERROR cases
// where the JSON message is just a useless placeholder.
const consoleErrors = new Map<string, string>();
if (logPath) {
  const lines = stripAnsi(readFileSync(logPath, "utf8")).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/ FAIL\s+\|\w+\|\s+\S+ > (.+)$/);
    if (!m) continue;
    const name = m[1].trim();
    // Look ahead for the first error-ish line before the stack / next FAIL.
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const l = lines[j].trimEnd();
      if (!l.trim() || / FAIL /.test(l)) continue;
      if (/^\s*❯/.test(l) || /^⎯+/.test(l)) break;
      if (!consoleErrors.has(name)) consoleErrors.set(name, l.trim());
      break;
    }
  }
}

const report = JSON.parse(readFileSync(jsonPath, "utf8"));

interface Failure {
  file: string;
  name: string;
  error: string;
}
const failures: Failure[] = [];

for (const tr of report.testResults ?? []) {
  const file = relFile(tr.name);
  for (const a of tr.assertionResults ?? []) {
    if (a.status !== "failed") continue;
    const name = [...(a.ancestorTitles ?? []), a.title].join(" > ");
    const msg0 = a.failureMessages?.[0] ?? "";
    let error = firstErrorLine(msg0);
    if (!error || error.includes("STACK_TRACE_ERROR")) {
      error = consoleErrors.get(name) ?? error ?? "(no error message captured)";
    }
    failures.push({ file, name, error });
  }
}

failures.sort(
  (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name),
);

// Group by file for readability.
const byFile = new Map<string, Failure[]>();
for (const f of failures) {
  const arr = byFile.get(f.file) ?? [];
  arr.push(f);
  byFile.set(f.file, arr);
}

const out: string[] = [];
out.push(`# Failed Cloudflare tests (temporary account run)`);
out.push(`# total failed: ${failures.length} across ${byFile.size} files`);
out.push("");
for (const [file, fs] of [...byFile.entries()].sort()) {
  out.push(file);
  for (const f of fs) {
    out.push(`  - ${f.name}`);
    out.push(`      ${f.error}`);
  }
  out.push("");
}

writeFileSync(outPath, out.join("\n"));
console.log(`Wrote ${failures.length} failures to ${outPath}`);
