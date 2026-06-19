import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { findProviderByType } from "./Provider.ts";
import type { CompiledStack } from "./Stack.ts";
import * as State from "./State/index.ts";

export const tail = Effect.fn(function* <Output, Services>(
  stack: CompiledStack<Output, Services>,
  filter?: ReadonlySet<string>,
) {
  const state = yield* yield* State.State;
  if (filter) {
    const ids = new Set(Object.values(stack.resources).map((r) => r.LogicalId));
    for (const id of filter) {
      if (!ids.has(id)) {
        return yield* Effect.die(
          new Error(
            `Unknown resource '${id}' in --filter. Available: ${Array.from(ids).sort().join(", ")}`,
          ),
        );
      }
    }
  }
  const tailable = yield* Effect.filterMapEffect(
    Object.entries(stack.resources),
    Effect.fn(function* ([fqn, resource]) {
      if (filter && !filter.has(resource.LogicalId)) return Result.failVoid;
      const resourceState = yield* state.get({
        stack: stack.name,
        stage: stack.stage,
        fqn,
      });
      if (
        !resourceState ||
        resourceState.kind === "action" ||
        !resourceState.attr
      )
        return Result.failVoid;
      const provider = yield* findProviderByType(resource.Type);
      if (!provider.tail) return Result.failVoid;
      return Result.succeed({
        logicalId: resource.LogicalId,
        stream: provider.tail({
          id: resource.LogicalId,
          instanceId: resourceState.instanceId,
          props: resourceState.props,
          output: resourceState.attr,
        }),
      });
    }),
    { concurrency: "unbounded" },
  );
  if (tailable.length === 0) {
    if (filter) {
      yield* Console.log(
        "No tailable resources match --filter (deploy first, or selected resources may not support tail).",
      );
    } else {
      yield* Console.log(
        "No tailable resources found. Deploy first, then run tail.",
      );
    }
    return;
  }
  yield* Console.log(`Tailing: ${tailable.map((t) => t.logicalId).join(", ")}`);
  const streams = tailable.map((t, i) => {
    const color = TAIL_COLORS[i % TAIL_COLORS.length]!;
    return t.stream.pipe(
      Stream.map(({ timestamp, message }) => {
        const ts = formatLocalTimestamp(timestamp);
        return `${color}${ts} [${t.logicalId}]${TAIL_RESET} ${message}`;
      }),
    );
  });
  yield* Stream.mergeAll(streams, { concurrency: "unbounded" }).pipe(
    Stream.runForEach((line) => Console.log(line)),
  );
});

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
