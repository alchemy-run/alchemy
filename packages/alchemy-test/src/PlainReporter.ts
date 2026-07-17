/**
 * Line-oriented reporter for non-interactive terminals and CI.
 *
 * Logs one line per test as it finishes (failures include their error and
 * captured output inline); if nothing finishes for 10s it prints the list of
 * currently-running tests; at the end every failure is repeated consolidated.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { LogEntry } from "./Model.ts";
import {
  Reporter,
  type RunSummary,
  type TestEvent,
  type TestMeta,
} from "./Reporter.ts";
import { writeDirect } from "./StrayOutput.ts";

const useColor =
  process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

const paint = (code: string) => (text: string) =>
  useColor ? `\u001B[${code}m${text}\u001B[0m` : text;

const red = paint("31");
const green = paint("32");
const yellow = paint("33");
const dim = paint("2");
const bold = paint("1");

const formatDuration = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;

// Through the REAL stream — while a run is active, bare process.stdout is
// diverted into the run log (see StrayOutput.ts).
const write = (line: string): Effect.Effect<void> =>
  Effect.sync(() => {
    writeDirect(`${line}\n`);
  });

// Captured output is replayed verbatim — no timestamp/level prefixes, no
// indentation. It should read exactly as it would have on a normal terminal.
const formatLogs = (logs: ReadonlyArray<LogEntry>): string =>
  logs.map((log) => log.message).join("\n");

const indent = (text: string, prefix = "  "): string =>
  text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");

/** Mutable per-run reporter state. */
interface ReporterState {
  readonly hookLogs: Map<string, ReadonlyArray<LogEntry>>;
  readonly running: Map<string, { meta: TestMeta; startedAt: number }>;
  lastEnd: number;
  /** Running-set fingerprint of the last stall report — dedupes repeats. */
  lastStallKey: string;
  stallTimer: ReturnType<typeof setInterval> | undefined;
}

const STALL_AFTER_MS = 10_000;
const STALL_LIST_MAX = 25;

/**
 * Print the currently-running tests when nothing has finished for a while.
 * Printed AT MOST ONCE per distinct running set: while the exact same tests
 * stay stuck, nothing is re-printed — the timestamp on the report tells the
 * reader how long ago it was taken.
 */
const printStalled = (state: ReporterState): void => {
  if (state.running.size === 0) return;
  if (Date.now() - state.lastEnd < STALL_AFTER_MS) return;
  const key = [...state.running.keys()].sort().join("\n");
  if (key === state.lastStallKey) return;
  state.lastStallKey = key;
  const now = Date.now();
  const timestamp = new Date(now).toTimeString().slice(0, 8);
  const items = [...state.running.values()].sort(
    (a, b) => a.startedAt - b.startedAt,
  );
  const lines = [
    dim(
      `⧗ [${timestamp}] no tests finished in the last 10s — ${items.length} still running:`,
    ),
  ];
  for (const item of items.slice(0, STALL_LIST_MAX)) {
    lines.push(
      dim(
        `    ${item.meta.file} > ${item.meta.titlePath.join(" > ")} (${formatDuration(now - item.startedAt)})`,
      ),
    );
  }
  if (items.length > STALL_LIST_MAX) {
    lines.push(dim(`    … ${items.length - STALL_LIST_MAX} more`));
  }
  writeDirect(`${lines.join("\n")}\n`);
};

const onEvent = (
  event: TestEvent,
  state: ReporterState,
): Effect.Effect<void> => {
  switch (event._tag) {
    case "CollectStart":
      return write(dim(`collecting ${event.files.length} test files...`));
    case "RunStart":
      return write(
        dim(`running ${event.tests.length} tests from ${event.files} files\n`),
      );
    case "TestStart":
      return Effect.sync(() => {
        state.running.set(event.test.id, {
          meta: event.test,
          startedAt: Date.now(),
        });
      });
    case "TestEnd": {
      state.running.delete(event.test.id);
      state.lastEnd = Date.now();
      const title = `${dim(event.test.file)} ${dim(">")} ${event.test.titlePath.join(` ${dim(">")} `)}`;
      const duration = dim(`(${formatDuration(event.result.durationMs)})`);
      const retries =
        event.result.retries > 0
          ? yellow(` [retried x${event.result.retries}]`)
          : "";
      switch (event.result.status) {
        case "pass":
          return write(`${green("✓")} ${title} ${duration}${retries}`);
        case "fail": {
          // Show the failure's details immediately so it can be inspected
          // while the run continues (passed tests stay silent). The end-of-run
          // Failures section repeats them consolidated, with file hook logs.
          const lines = [`${red("✗")} ${title} ${duration}${retries}`];
          if (event.result.error !== undefined) {
            lines.push(indent(red(event.result.error)));
          }
          if (event.result.logs.length > 0) {
            lines.push(dim("--- captured output ---"));
            lines.push(formatLogs(event.result.logs));
            lines.push(dim("--- end output ---"));
          }
          return write(lines.join("\n"));
        }
        case "skip":
          return write(`${yellow("↓")} ${title} ${dim("[skipped]")}`);
        case "todo":
          // Warning-styled: a todo is unimplemented coverage, not a pass —
          // it must not blend in with the dim noise around it.
          return write(
            yellow(
              `○ ${event.test.file} > ${event.test.titlePath.join(" > ")} ${bold("[todo]")}`,
            ),
          );
      }
    }
    case "FileEnd": {
      if (event.logs.length > 0) {
        state.hookLogs.set(event.file, event.logs);
      }
      if (event.error !== undefined) {
        return write(
          `${red("✗")} ${bold(event.file)} ${red("failed to run")}\n${indent(red(event.error))}` +
            (event.logs.length > 0
              ? `\n${dim("--- file hook output (deploy/destroy) ---")}\n${formatLogs(event.logs)}`
              : ""),
        );
      }
      return Effect.void;
    }
    case "RunEnd":
      return printSummary(event.summary, state.hookLogs);
    default:
      return Effect.void;
  }
};

export const printSummary = (
  summary: RunSummary,
  /** Buffered deploy/destroy output per file, printed once per failing file. */
  hookLogs?: ReadonlyMap<string, ReadonlyArray<LogEntry>>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (summary.failures.length > 0) {
      yield* write(`\n${bold(red(`Failures (${summary.failures.length})`))}\n`);
      const hookLogsPrinted = new Set<string>();
      for (const { meta, result } of summary.failures) {
        yield* write(
          `${red("✗")} ${bold(meta.file)} ${dim(">")} ${meta.titlePath.join(` ${dim(">")} `)}`,
        );
        if (result.error !== undefined) {
          yield* write(indent(red(result.error)));
        }
        if (result.logs.length > 0) {
          yield* write(dim("--- captured output ---"));
          yield* write(formatLogs(result.logs));
          yield* write(dim("--- end output ---"));
        }
        const fileHookLogs = hookLogs?.get(meta.file);
        if (
          fileHookLogs !== undefined &&
          fileHookLogs.length > 0 &&
          !hookLogsPrinted.has(meta.file)
        ) {
          hookLogsPrinted.add(meta.file);
          yield* write(dim("--- file hook output (deploy/destroy) ---"));
          yield* write(formatLogs(fileHookLogs));
          yield* write(dim("--- end output ---"));
        }
        yield* write("");
      }
    }
    const parts = [
      summary.failed > 0 ? red(`${summary.failed} failed`) : green("0 failed"),
      green(`${summary.passed} passed`),
      ...(summary.skipped > 0 ? [yellow(`${summary.skipped} skipped`)] : []),
      ...(summary.todo > 0 ? [yellow(`${summary.todo} todo`)] : []),
    ];
    yield* write(
      `\n${bold("Tests:")} ${parts.join(dim(" | "))} ${dim(`(${summary.files} files, ${formatDuration(summary.durationMs)})`)}`,
    );
  });

export const PlainReporterLive: Layer.Layer<Reporter> = Layer.sync(Reporter)(
  () => {
    const state: ReporterState = {
      hookLogs: new Map(),
      running: new Map(),
      lastEnd: Date.now(),
      lastStallKey: "",
      stallTimer: undefined,
    };
    return {
      emit: (event) =>
        Effect.suspend(() => {
          if (event._tag === "RunStart" && state.stallTimer === undefined) {
            state.stallTimer = setInterval(() => printStalled(state), 1000);
            // Don't hold the process open once the run's fibers finish.
            (state.stallTimer as unknown as { unref?: () => void }).unref?.();
          }
          if (event._tag === "RunEnd" && state.stallTimer !== undefined) {
            clearInterval(state.stallTimer);
            state.stallTimer = undefined;
          }
          return onEvent(event, state);
        }),
      waitForExit: () => Effect.void,
    };
  },
);
