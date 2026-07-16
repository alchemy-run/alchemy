/**
 * Persistent run log: every test's pass/failure followed by its captured
 * output, appended to `.alchemy/log/test.log` as the run progresses —
 * color-free so agents and tooling can read it directly.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { LogEntry } from "./Model.ts";
import type { TestEvent } from "./Reporter.ts";

const formatDuration = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;

const formatLogs = (logs: ReadonlyArray<LogEntry>): string =>
  logs.map((log) => log.message).join("\n");

const GLYPH = {
  pass: "PASS",
  fail: "FAIL",
  skip: "SKIP",
  todo: "TODO",
} as const;

/** Render an event as a log chunk; `undefined` = nothing to write. */
export const formatEvent = (event: TestEvent): string | undefined => {
  switch (event._tag) {
    case "RunStart":
      return `running ${event.tests.length} tests from ${event.files} files (${new Date().toISOString()})\n\n`;
    case "TestEnd": {
      const title = `${event.test.file} > ${event.test.titlePath.join(" > ")}`;
      const retries =
        event.result.retries > 0 ? ` [retried x${event.result.retries}]` : "";
      const lines = [
        `${GLYPH[event.result.status]} ${title} (${formatDuration(event.result.durationMs)})${retries}`,
      ];
      if (event.result.error !== undefined) {
        lines.push(event.result.error);
      }
      if (event.result.logs.length > 0) {
        lines.push("--- captured output ---");
        lines.push(formatLogs(event.result.logs));
        lines.push("--- end output ---");
      }
      return `${lines.join("\n")}\n\n`;
    }
    case "FileEnd": {
      const lines: Array<string> = [];
      if (event.error !== undefined) {
        lines.push(`FAIL ${event.file} failed to run`, event.error);
      }
      if (event.logs.length > 0) {
        lines.push(`--- file hook output (${event.file}) ---`);
        lines.push(formatLogs(event.logs));
        lines.push("--- end output ---");
      }
      return lines.length === 0 ? undefined : `${lines.join("\n")}\n\n`;
    }
    case "RunEnd": {
      const s = event.summary;
      return (
        `Tests: ${s.failed} failed | ${s.passed} passed` +
        (s.skipped > 0 ? ` | ${s.skipped} skipped` : "") +
        (s.todo > 0 ? ` | ${s.todo} todo` : "") +
        ` (${s.files} files, ${formatDuration(s.durationMs)})\n`
      );
    }
    default:
      return undefined;
  }
};

export interface FileLog {
  readonly append: (event: TestEvent) => Effect.Effect<void>;
}

/** Create (truncate) the log file and return an event appender. */
export const makeFileLog = Effect.fn(function* (logFile: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs
    .makeDirectory(path.dirname(logFile), { recursive: true })
    .pipe(Effect.ignore);
  yield* fs.writeFileString(logFile, "").pipe(Effect.ignore);
  const append: FileLog["append"] = (event) => {
    const chunk = formatEvent(event);
    if (chunk === undefined) return Effect.void;
    return fs
      .writeFileString(logFile, chunk, { flag: "a" })
      .pipe(Effect.ignore);
  };
  return { append } satisfies FileLog;
});
