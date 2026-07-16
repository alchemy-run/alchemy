/**
 * Line-oriented reporter for non-interactive terminals and CI.
 *
 * Logs one line per test as it finishes; at the end prints every failed test
 * with its error and buffered Effect log/Console output.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { LogEntry } from "./Model.ts";
import { Reporter, type RunSummary, type TestEvent } from "./Reporter.ts";

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

const write = (line: string): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(`${line}\n`);
  });

const formatLogs = (logs: ReadonlyArray<LogEntry>): string =>
  logs
    .map((log) => {
      const time = log.time.toISOString().slice(11, 23);
      return `  ${dim(`[${time}]`)} ${dim(log.level.padEnd(5))} ${log.message.replaceAll("\n", "\n         ")}`;
    })
    .join("\n");

const indent = (text: string, prefix = "  "): string =>
  text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");

const onEvent = (event: TestEvent): Effect.Effect<void> => {
  switch (event._tag) {
    case "CollectStart":
      return write(dim(`collecting ${event.files.length} test files...`));
    case "RunStart":
      return write(dim(`running tests from ${event.files} files\n`));
    case "TestEnd": {
      const title = `${dim(event.test.file)} ${dim(">")} ${event.test.titlePath.join(` ${dim(">")} `)}`;
      const duration = dim(`(${formatDuration(event.result.durationMs)})`);
      const retries =
        event.result.retries > 0
          ? yellow(` [retried x${event.result.retries}]`)
          : "";
      switch (event.result.status) {
        case "pass":
          return write(`${green("✓")} ${title} ${duration}${retries}`);
        case "fail":
          return write(`${red("✗")} ${title} ${duration}${retries}`);
        case "skip":
          return write(`${yellow("↓")} ${title} ${dim("[skipped]")}`);
        case "todo":
          return write(`${dim("○")} ${title} ${dim("[todo]")}`);
      }
    }
    case "FileEnd": {
      if (event.error !== undefined) {
        return write(
          `${red("✗")} ${bold(event.file)} ${red("failed to run")}\n${indent(red(event.error))}`,
        );
      }
      return Effect.void;
    }
    case "RunEnd":
      return printSummary(event.summary);
    default:
      return Effect.void;
  }
};

export const printSummary = (summary: RunSummary): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (summary.failures.length > 0) {
      yield* write(`\n${bold(red(`Failures (${summary.failures.length})`))}\n`);
      for (const { meta, result } of summary.failures) {
        yield* write(
          `${red("✗")} ${bold(meta.file)} ${dim(">")} ${meta.titlePath.join(` ${dim(">")} `)}`,
        );
        if (result.error !== undefined) {
          yield* write(indent(red(result.error)));
        }
        if (result.logs.length > 0) {
          yield* write(dim("  --- captured output ---"));
          yield* write(formatLogs(result.logs));
        }
        yield* write("");
      }
    }
    const parts = [
      summary.failed > 0 ? red(`${summary.failed} failed`) : green("0 failed"),
      green(`${summary.passed} passed`),
      ...(summary.skipped > 0 ? [yellow(`${summary.skipped} skipped`)] : []),
      ...(summary.todo > 0 ? [dim(`${summary.todo} todo`)] : []),
    ];
    yield* write(
      `\n${bold("Tests:")} ${parts.join(dim(" | "))} ${dim(`(${summary.files} files, ${formatDuration(summary.durationMs)})`)}`,
    );
  });

export const PlainReporterLive: Layer.Layer<Reporter> = Layer.succeed(
  Reporter,
  {
    emit: onEvent,
    waitForExit: () => Effect.void,
  },
);
