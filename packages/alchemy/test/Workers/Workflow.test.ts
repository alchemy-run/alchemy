import {
  runWorkflowTask,
  withWorkflowScope,
} from "@/Workers/WorkflowCallback.ts";
import {
  callbackFailure,
  decodeApplicationFailure,
  terminalFailureMessage,
} from "@/Workers/WorkflowFailure.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";

class Busy extends Data.TaggedError("Busy")<{
  attempt: number;
  data?: unknown;
}> {}
class Terminal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}
const identity = { workflow: "Workflow", instanceId: "instance" };
const terminalFailure = (message: string) =>
  Effect.runPromise(
    Effect.sync(() => new Terminal(terminalFailureMessage(message))),
  );
const encode = (value: unknown) =>
  Effect.promise(() =>
    callbackFailure(Cause.fail(value), terminalFailure, "task", identity),
  );

describe("shared Workflow failures", () => {
  it.effect(
    "restores tagged data and supported built-ins without claiming prototype identity",
    () =>
      Effect.gen(function* () {
        const original = new Busy({
          attempt: 2,
          data: {
            date: new Date(123),
            bytes: new Uint8Array([1, 2]),
            buffer: new Uint8Array([3, 4]).buffer,
            map: new Map([["key", 12n]]),
            set: new Set([undefined, Infinity]),
            nan: NaN,
            negativeZero: -0,
          },
        });
        const error = yield* encode(original);
        const restored = yield* Effect.promise(() =>
          decodeApplicationFailure<Busy>(
            new Error(error.message),
            "task",
            identity,
          ),
        );
        expect(restored).toBeDefined();
        const value = Cause.squash(restored!);
        expect(value).toMatchObject({ _tag: "Busy", attempt: 2 });
        expect(value).not.toBe(original);
        expect(value).not.toBeInstanceOf(Busy);
        expect((value as Busy).data).toEqual(original.data);
      }),
  );

  it.effect("supports inherited application tags", () =>
    Effect.gen(function* () {
      const original = yield* Effect.sync(() =>
        Object.create(
          { _tag: "Inherited" },
          {
            value: { value: 42, enumerable: true },
          },
        ),
      );
      const error = yield* encode(original);
      const restored = yield* Effect.promise(() =>
        decodeApplicationFailure(error, "task", identity),
      );
      expect(Cause.squash(restored!)).toEqual({ _tag: "Inherited", value: 42 });
    }),
  );

  const unsupported: Array<[string, () => unknown]> = [
    ["functions", () => ({ fn() {} })],
    ["symbols", () => ({ value: Symbol("value") })],
    ["symbol keys", () => ({ [Symbol("key")]: 1 })],
    [
      "cycles",
      () => {
        const value: unknown[] = [];
        value.push(value);
        return value;
      },
    ],
    [
      "shared references",
      () => {
        const value = {};
        return [value, value];
      },
    ],
    ["accessors", () => Object.defineProperty({}, "value", { get: () => 1 })],
    [
      "tag accessors",
      () =>
        Object.create({
          get _tag() {
            return "Bad";
          },
        }),
    ],
    ["oversized values", () => "x".repeat(16_384)],
    ["sparse arrays", () => new Array(2)],
    [
      "depth over 64",
      () => {
        let value: unknown = {};
        for (let i = 0; i < 64; i++) value = { value };
        return value;
      },
    ],
  ];
  for (const [name, make] of unsupported) {
    it.effect(`rejects ${name} as terminal`, () =>
      Effect.gen(function* () {
        const value = yield* Effect.sync(make);
        const error = yield* Effect.tryPromise({
          try: () =>
            callbackFailure(
              Cause.fail(value),
              terminalFailure,
              "task",
              identity,
            ),
          catch: (error) => error,
        }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(Terminal);
        expect((error as Error).message).toContain("not serializable");
      }),
    );
  }

  it.effect("accepts exactly 64 nested containers", () =>
    Effect.gen(function* () {
      const value = yield* Effect.sync(() => {
        let value: unknown = null;
        for (let i = 0; i < 64; i++) value = { value };
        return value;
      });
      const error = yield* encode(value);
      const cause = yield* Effect.promise(() =>
        decodeApplicationFailure(error, "task", identity),
      );
      expect(Cause.squash(cause!)).toEqual(value);
    }),
  );

  it.effect(
    "rejects tampering and cross-instance replay while preserving native controls",
    () =>
      Effect.gen(function* () {
        const error = yield* encode(new Busy({ attempt: 2 }));
        for (const [failure, step, owner] of [
          [new Error(`${error.message}changed`), "task", identity],
          [error, "different", identity],
          [error, "task", { ...identity, instanceId: "other" }],
        ] as const) {
          const exit = yield* Effect.promise(() =>
            decodeApplicationFailure(failure, step, owner),
          ).pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
        }
        const terminal = new Terminal(error.message);
        expect(
          yield* Effect.promise(() =>
            decodeApplicationFailure(terminal, "task", identity),
          ),
        ).toBeUndefined();
      }),
  );
});

describe("shared Workflow callback lifetime", () => {
  it.effect(
    "closes fresh attempts before retry and preserves the original in-flight Cause",
    () =>
      Effect.gen(function* () {
        const scopes: Scope.Scope[] = [];
        const entries: string[] = [];
        const error = new Busy({ attempt: 2 });
        const cause = Cause.fail(error);
        const exit = yield* runWorkflowTask({
          name: "task",
          identity,
          terminalFailure,
          effect: (attempt: number) =>
            Effect.gen(function* () {
              scopes.push(yield* Scope.Scope);
              entries.push(`open:${attempt}`);
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  entries.push(`close:${attempt}`);
                }),
              );
              return yield* Effect.failCause(cause);
            }),
          native: (callback) =>
            Effect.runPromise(
              Effect.gen(function* () {
                yield* Effect.tryPromise({
                  try: () => callback(1),
                  catch: (e) => e,
                }).pipe(Effect.result);
                return yield* Effect.promise(() => callback(2));
              }),
            ),
        }).pipe(Effect.exit);
        expect(scopes[0]).not.toBe(scopes[1]);
        expect(entries).toEqual(["open:1", "close:1", "open:2", "close:2"]);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBe(error);
          expect(exit.cause.reasons).toHaveLength(cause.reasons.length);
          expect(Cause.hasDies(exit.cause)).toBe(false);
        }
      }),
  );

  it.effect(
    "restores persisted failures without reexecuting the callback",
    () =>
      Effect.gen(function* () {
        const error = yield* encode(new Busy({ attempt: 2 }));
        let executed = false;
        const value = yield* runWorkflowTask<void, Busy, void>({
          name: "task",
          identity,
          terminalFailure,
          effect: () =>
            Effect.sync(() => {
              executed = true;
            }),
          native: () => Effect.runPromise(Effect.die(new Error(error.message))),
        }).pipe(
          Effect.catchTag("Busy", (error) => Effect.succeed(error.attempt)),
        );
        expect(value).toBe(2);
        expect(executed).toBe(false);
      }),
  );

  it.live("interrupts and joins active callback finalizers", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const entries: string[] = [];
      const fiber = yield* runWorkflowTask({
        name: "task",
        identity,
        terminalFailure,
        effect: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sleep("10 millis").pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    entries.push("closed");
                  }),
                ),
              ),
            );
            yield* Deferred.succeed(started, undefined);
            yield* Effect.never;
          }),
        native: (callback) => callback(undefined),
      }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      entries.push("joined");
      expect(entries).toEqual(["closed", "joined"]);
    }),
  );

  it.effect(
    "does not let native control errors become application failures",
    () =>
      Effect.gen(function* () {
        const error = new Error("Aborting engine: User called pause");
        const exit = yield* runWorkflowTask({
          name: "task",
          identity,
          terminalFailure,
          effect: () => Effect.succeed(1),
          native: () => Effect.runPromise(Effect.die(error)),
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true);
          expect(Cause.squash(exit.cause)).toBe(error);
        }
      }),
  );

  it.effect(
    "does not replace run success or failure with cleanup defects",
    () =>
      Effect.gen(function* () {
        for (const body of [Effect.succeed("ok"), Effect.fail("original")]) {
          const exit = yield* withWorkflowScope(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Effect.die("cleanup"));
              return yield* body;
            }),
          ).pipe(Effect.exit);
          const expected = yield* body.pipe(Effect.exit);
          expect(exit._tag).toBe(expected._tag);
          if (Exit.isFailure(exit)) {
            expect(Cause.squash(exit.cause)).toBe("original");
            expect(Cause.hasDies(exit.cause)).toBe(false);
          } else expect(exit.value).toBe("ok");
        }
      }),
  );
});
