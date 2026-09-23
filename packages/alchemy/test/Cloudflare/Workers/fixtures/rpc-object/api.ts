import * as Cloudflare from "@/Cloudflare";
import { RuntimeContext } from "@/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { RpcObjectStatsWorker } from "./stats-worker.ts";

export class ObjectRejected extends Data.TaggedError("ObjectRejected")<{
  readonly code: number;
  readonly message: string;
}> {}

export const makeApi = Effect.gen(function* () {
  const stats = yield* Cloudflare.Workers.bindWorker(RpcObjectStatsWorker);

  const pure = () =>
    Effect.succeed({
      echo: <T>(value: T): Effect.Effect<T> => Effect.succeed(value),
      select: <T, K extends keyof T>(value: T, key: K): Effect.Effect<T[K]> =>
        Effect.succeed(value[key]),
    });

  const open = Effect.fn(function* (id: string) {
    const runtime = yield* RuntimeContext;
    const record = (event: string) =>
      stats
        .append(id, event)
        .pipe(Effect.provideService(RuntimeContext, runtime), Effect.orDie);
    let closed = false;
    yield* Effect.acquireRelease(record("parent:open"), () =>
      Effect.sync(() => {
        closed = true;
      }).pipe(Effect.andThen(record("parent:close"))),
    );
    const ping = () =>
      Effect.gen(function* () {
        yield* record("parent:ping");
        if (closed)
          return yield* Effect.die(new Error("parent already closed"));
        return id;
      });
    const tracked = <A, E>(name: string, stream: Stream.Stream<A, E>) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* record(`stream:${name}:open`);
          yield* Effect.addFinalizer(() => record(`stream:${name}:close`));
          return stream;
        }),
      );
    return {
      echo: <T>(value: T): Effect.Effect<T> => Effect.succeed(value),
      select: <T, K extends keyof T>(value: T, key: K): Effect.Effect<T[K]> =>
        Effect.succeed(value[key]),
      scalar: (value: number) => Effect.succeed(value + 1),
      forwarded: () => stats.record(),
      runtime: () =>
        Effect.gen(function* () {
          return (yield* RuntimeContext).Type;
        }),
      runtimeValues: () =>
        Stream.fromEffect(
          Effect.gen(function* () {
            return (yield* RuntimeContext).Type;
          }),
        ),
      ping,
      reject: () =>
        Effect.fail(
          new ObjectRejected({ code: 409, message: "object rejected" }),
        ),
      defect: () => Effect.die(new Error("object defect")),
      operation: Effect.fn(function* (
        mode: "success" | "failure" | "interrupt",
      ) {
        yield* record(`method:${mode}:open`);
        yield* Effect.addFinalizer(() => record(`method:${mode}:close`));
        if (mode === "failure") {
          return yield* Effect.fail(
            new ObjectRejected({ code: 422, message: "method rejected" }),
          );
        }
        if (mode === "interrupt") return yield* Effect.never;
        return "method-ok";
      }),
      child: Effect.fn(function* () {
        let childClosed = false;
        yield* Effect.acquireRelease(record("child:open"), () =>
          Effect.sync(() => {
            childClosed = true;
          }).pipe(Effect.andThen(record("child:close"))),
        );
        return {
          echo: <T>(value: T): Effect.Effect<T> => Effect.succeed(value),
          ping: () =>
            Effect.gen(function* () {
              if (childClosed)
                return yield* Effect.die(new Error("child already closed"));
              return yield* ping();
            }),
          reject: () =>
            Effect.fail(
              new ObjectRejected({ code: 410, message: "child rejected" }),
            ),
          values: () => tracked("child", Stream.make("child-a", "child-b")),
        };
      }),
      bytes: () =>
        tracked(
          "bytes",
          Stream.make(new Uint8Array([0, 1, 255]), new Uint8Array([2, 3])),
        ),
      json: () =>
        tracked(
          "json",
          Stream.make(
            { index: 0, value: "alpha" },
            { index: 1, value: "beta" },
          ),
        ),
      richValues: () =>
        tracked(
          "rich",
          Stream.suspend(() => {
            const cycle: { label: string; self?: unknown } = { label: "cycle" };
            cycle.self = cycle;
            return Stream.make(
              undefined,
              NaN,
              9007199254740993n,
              new Date("2026-09-20T12:34:56.789Z"),
              new Map([["one", 1n]]),
              new Set(["alpha", "beta"]),
              new Uint16Array([0, 256, 65535]),
              {
                nested: {
                  bigint: 1234567890123456789n,
                  date: new Date("2026-01-02T03:04:05.000Z"),
                  map: new Map([["set", new Set([2n, 3n])]]),
                  bytes: new Uint8Array([0, 255, 42]),
                  words: new Uint16Array([256, 65535]),
                  undefined: undefined,
                  nan: NaN,
                },
              },
              cycle,
            );
          }),
        ),
      initialFailure: () =>
        tracked(
          "initial-failure",
          Stream.fail(
            new ObjectRejected({
              code: 400,
              message: "stream rejected before first item",
            }),
          ),
        ),
      byteFailure: () =>
        tracked(
          "byte-failure",
          Stream.make(new Uint8Array([0, 17, 255])).pipe(
            Stream.concat(
              Stream.fail(
                new ObjectRejected({
                  code: 502,
                  message: "stream rejected after bytes",
                }),
              ),
            ),
          ),
        ),
      delayedFirst: () =>
        tracked(
          "delayed-first",
          Stream.fromEffect(
            Effect.sleep("75 millis").pipe(
              Effect.as({ value: "first-after-delay" }),
            ),
          ),
        ),
      pendingFirst: () =>
        tracked("pending-first", Stream.fromEffect(Effect.never)),
      empty: () => tracked("empty", Stream.empty),
      delayed: () =>
        tracked(
          "delayed",
          Stream.fromIterable([1, 2, 3]).pipe(
            Stream.mapEffect((value) =>
              Effect.sleep("25 millis").pipe(Effect.as(value)),
            ),
          ),
        ),
      failing: () =>
        tracked(
          "failing",
          Stream.make("before-failure").pipe(
            Stream.concat(
              Stream.fail(
                new ObjectRejected({ code: 503, message: "stream rejected" }),
              ),
            ),
          ),
        ),
      cancellable: () =>
        tracked(
          "cancel",
          Stream.make("first").pipe(
            Stream.concat(Stream.fromEffect(Effect.never)),
          ),
        ),
      largeBytes: (size: number) =>
        Effect.sync(() => new Uint8Array(size).fill(37)),
      largeObjects: (count: number) =>
        Effect.sync(() =>
          Array.from({ length: count }, (_, index) => ({
            index,
            value: `row-${index}`,
            active: index % 2 === 0,
          })),
        ),
      backingBuffers: () =>
        Stream.range(0, 64).pipe(
          Stream.map((index) => {
            const view = new Uint16Array(new ArrayBuffer(512 * 1024), 0, 1);
            view[0] = index;
            return view;
          }),
        ),
      largeRecords: () =>
        Stream.range(0, 127).pipe(
          Stream.map((index) => ({
            index,
            value: `${index.toString().padStart(4, "0")}${"x".repeat(300 * 1024 - 4)}`,
          })),
        ),
      largeStream: (chunks: number, size: number) =>
        Stream.range(0, chunks - 1).pipe(
          Stream.map((index) => new Uint8Array(size).fill(index % 256)),
        ),
    };
  });

  // A returned object that mixes data with methods nested at any depth.
  const session = Effect.fn(function* (id: string) {
    const runtime = yield* RuntimeContext;
    const record = (event: string) =>
      stats
        .append(id, event)
        .pipe(Effect.provideService(RuntimeContext, runtime), Effect.orDie);
    yield* Effect.acquireRelease(record("session:open"), () =>
      record("session:close"),
    );
    let count = 0;
    return {
      id,
      createdAt: new Date("2026-01-02T03:04:05.000Z"),
      meta: { owner: "alchemy", tags: ["a", "b"] },
      increment: () => Effect.sync(() => ++count),
      stats: {
        label: "visits",
        current: () => Effect.sync(() => count),
      },
      items: [
        { name: "first", bump: () => Effect.sync(() => (count += 10)) },
        { name: "second", bump: () => Effect.sync(() => (count += 100)) },
      ],
      child: () =>
        Effect.succeed({
          echo: <T>(value: T): Effect.Effect<T> => Effect.succeed(value),
        }),
      values: () => Stream.make(1, 2, 3),
      reject: () =>
        Effect.fail(
          new ObjectRejected({ code: 418, message: "session rejected" }),
        ),
    };
  });

  return {
    ready: () => stats.ready(),
    scalar: (value: number) => Effect.succeed(value + 1),
    pure,
    open,
    session,
    rejectOpen: (): Effect.Effect<
      { increment: () => Effect.Effect<number> },
      ObjectRejected
    > =>
      Effect.fail(new ObjectRejected({ code: 401, message: "open rejected" })),
    pending: Effect.fn(function* (id: string) {
      const runtime = yield* RuntimeContext;
      const record = (event: string) =>
        stats
          .append(id, event)
          .pipe(Effect.provideService(RuntimeContext, runtime), Effect.orDie);
      yield* Effect.acquireRelease(record("factory:open"), () =>
        record("factory:close"),
      );
      yield* Effect.never;
      return yield* pure();
    }),
  };
});
