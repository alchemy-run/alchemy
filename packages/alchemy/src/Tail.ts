import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { findProviderByType, type LogLine } from "./Provider.ts";
import type { StackSpec } from "./Stack.ts";
import * as State from "./State/index.ts";

/**
 * Shared tail orchestration: enumerate a stack's deployed resources, open
 * each provider's `tail` stream, and merge them into colored, timestamped
 * console output. Used by the `alchemy tail` CLI command and (when test
 * logging is enabled) forked by the test harness after deploy.
 */

export const TAIL_COLORS = [
  "\x1b[36m", // cyan
  "\x1b[35m", // magenta
  "\x1b[33m", // yellow
  "\x1b[32m", // green
  "\x1b[34m", // blue
  "\x1b[91m", // bright red
  "\x1b[96m", // bright cyan
  "\x1b[95m", // bright magenta
  "\x1b[93m", // bright yellow
  "\x1b[92m", // bright green
];
export const TAIL_RESET = "\x1b[0m";

export const formatLocalTimestamp = (date: Date): string => {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  const tz =
    new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  return `${y}-${mo}-${d} ${h}:${mi}:${s}.${ms} ${tz}`;
};

export interface TailableResource {
  logicalId: string;
  stream: Stream.Stream<LogLine, any, any>;
}

/**
 * Enumerate the stack's resources and collect a tail stream for every one
 * that is deployed (has persisted attributes) and whose provider implements
 * `tail`. Runs against the stack's services (state store + providers must be
 * in context).
 */
export const discoverTailable = Effect.fn(function* (
  stack: StackSpec,
  options?: { filter?: ReadonlySet<string> },
) {
  const state = yield* yield* State.State;
  const tailable: TailableResource[] = [];

  for (const fqn of Object.keys(stack.resources)) {
    const resource = stack.resources[fqn]!;
    if (options?.filter && !options.filter.has(resource.LogicalId)) continue;

    const resourceState = yield* state.get({
      stack: stack.name,
      stage: stack.stage,
      fqn,
    });
    if (!(resourceState as any)?.attr) continue;

    const provider = yield* findProviderByType(resource.Type);
    if (!provider.tail) continue;

    tailable.push({
      logicalId: resource.LogicalId,
      stream: provider.tail({
        id: resource.LogicalId,
        fqn,
        instanceId: (resourceState as any).instanceId,
        props: (resourceState as any).props,
        output: (resourceState as any).attr,
      }),
    });
  }

  return tailable;
});

/**
 * Merge tail streams into a single colored, timestamped line stream and
 * print each line to the console. Runs until interrupted (tail streams
 * never end on their own).
 */
export const tailAll = (tailable: TailableResource[]) => {
  const taggedStreams = tailable.map(({ logicalId, stream }, i) => {
    const color = TAIL_COLORS[i % TAIL_COLORS.length]!;
    return stream.pipe(
      Stream.map(({ timestamp, message }) => {
        const ts = formatLocalTimestamp(timestamp);
        return `${color}${ts} [${logicalId}]${TAIL_RESET} ${message}`;
      }),
    );
  });

  return Stream.mergeAll(taggedStreams, {
    concurrency: "unbounded",
  }).pipe(Stream.runForEach((line) => Console.log(line)));
};

/**
 * Discover and tail everything tailable in the stack. A no-op when nothing
 * is tailable; otherwise runs until interrupted.
 */
export const tailStack = Effect.fn(function* (
  stack: StackSpec,
  options?: { filter?: ReadonlySet<string> },
) {
  const tailable = yield* discoverTailable(stack, options);
  if (tailable.length === 0) return;
  yield* tailAll(tailable);
});
