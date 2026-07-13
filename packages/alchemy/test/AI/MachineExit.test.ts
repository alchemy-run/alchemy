/**
 * Machine-observed exits (reassess §B): `AI.exit(AI.when(source))` —
 * the WORLD declares the run's end, not the model's `resolve` claim.
 * The run does one work round, then settles when a correlated event
 * arrives on the source (the model may CAUSE it by calling a tool, or
 * a human may). Correlation precedence: an explicit `match` override >
 * the source's own `key` equality > any event from the source.
 * Reconciler doctrine: observation > claim.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as Stream from "effect/Stream";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as Response from "effect/unstable/ai/Response";
import * as AI from "@/AI/index.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";

const IssueClosed = AI.EventSource(
  "github.issue.closed",
  S.Struct({ number: S.Number, by: S.String }),
);

// a KEY-BEARING source (the catalog pattern): the event family declares
// its natural identity once; the kernel's default exit correlation is
// key equality — no per-charter match callback
const KeyedIssueClosed = AI.EventSource(
  "github.issue.closed.keyed",
  S.Struct({ number: S.Number, by: S.String }),
  {
    owner: "world",
    key: (e: { number?: unknown }) =>
      typeof e?.number === "number" ? `#${e.number}` : undefined,
  },
);

const number = AI.Parameter("number", S.Number)`the issue number`;
class CloseIssue extends AI.Tool<CloseIssue>()("close_issue")`
Close issue ${number} once it is resolved.` {}

class IssueWork extends AI.Process<IssueWork>()("IssueWork")`
Work the issue. Close it with ${CloseIssue} when done.
${AI.exit(AI.when(IssueClosed))}` {}

// per-item correlation (canon §2: P0): the explicit `match` override
// ties an observed event to THIS run's work item — the run exits only
// on ITS issue's close, never a neighbor's
class KeyedIssueWork extends AI.Process<KeyedIssueWork>()("KeyedIssueWork")`
Work the issue. Close it with ${CloseIssue} when done.
${AI.exit(AI.when(IssueClosed), (item: string, event) => item.includes(`#${event.number}`))}` {}

// the same correlation with NO callback: the source's own `key` is the
// default — the work item carries the key fields, and the kernel
// settles on key equality
class KeyDefaultIssueWork extends AI.Process<KeyDefaultIssueWork>()(
  "KeyDefaultIssueWork",
)`
Work the issue. Close it with ${CloseIssue} when done.
${AI.exit(AI.when(KeyedIssueClosed))}` {}

const usage = {
  inputTokens: {
    uncached: undefined,
    total: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const finish = (reason: string): Response.StreamPartEncoded =>
  ({ type: "finish", reason, usage, response: undefined }) as never;
const toolCall = (id: string, name: string, params: unknown) =>
  ({ type: "tool-call", id, name, params, providerExecuted: false }) as never;
const scripted = (parts: Array<Response.StreamPartEncoded>) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.die(new Error("streamText only")),
      streamText: () => Stream.fromIterable(parts),
    }),
  );

describe("AI.exit(AI.when(eventSource)) — machine-observed exit", () => {
  it.effect("the model's close tool causes the event; run settles on it", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const kernel = yield* AI.Kernel;
          const work = yield* kernel.interpret(IssueWork);
          return (yield* work.dispatch("fix the bug in #42")) as {
            number: number;
            by: string;
          };
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            AI.memory.pipe(
              Layer.provide([
                scripted([
                  toolCall("c1", "close_issue", { number: 42 }),
                  finish("tool-calls"),
                ]),
                AI.EventBusMemory,
              ]),
            ),
            AI.EventBusMemory,
            // the close tool's physics PUBLISHES the world event — the
            // run settles on observing it, not on the model's word
            Layer.succeed(CloseIssue, ((input: { number: number }) =>
              Effect.gen(function* () {
                const bus = yield* AI.EventBus;
                yield* bus.publish(IssueClosed, {
                  number: input.number,
                  by: "agent",
                });
                return "closed";
              })) as never).pipe(Layer.provide(AI.EventBusMemory)),
            RuntimeContext.phantom,
          ),
        ),
      );

      // Out is the EVENT payload, not a model claim
      expect(outcome).toEqual({ number: 42, by: "agent" });
    }),
  );

  it.effect(
    "a human-closed issue settles the parked run (no model action)",
    () =>
      Effect.gen(function* () {
        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const bus = yield* AI.EventBus;
            const work = yield* kernel.interpret(IssueWork);

            // when the run parks (round done, waiting on the world), a
            // human closes the issue out of band — clock-free via the
            // firehose, no sleep
            yield* Effect.forkChild(
              kernel.events.pipe(
                Stream.filter((event) => event.type === "run.parked"),
                Stream.take(1),
                Stream.runForEach(() =>
                  bus.publish(IssueClosed, { number: 7, by: "maintainer" }),
                ),
              ),
            );

            const running = yield* Effect.forkChild(work.dispatch("triage #7"));
            return (yield* Fiber.join(running)) as { by: string };
          }),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              AI.memory.pipe(
                Layer.provide([
                  scripted([
                    { type: "text-start", id: "t" } as never,
                    { type: "text-delta", id: "t", delta: "looking" } as never,
                    { type: "text-end", id: "t" } as never,
                    finish("stop"),
                  ]),
                  AI.EventBusMemory,
                ]),
              ),
              AI.EventBusMemory,
              Layer.succeed(CloseIssue, (() =>
                Effect.succeed("closed")) as never),
              RuntimeContext.phantom,
            ),
          ),
        );

        expect(outcome.by).toBe("maintainer");
      }),
  );

  it.effect(
    "per-item match: a run settles only on ITS event, not a neighbor's",
    () =>
      Effect.gen(function* () {
        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const bus = yield* AI.EventBus;
            const work = yield* kernel.interpret(KeyedIssueWork);

            // when the run parks, close a DIFFERENT issue first (must
            // not settle it), then the run's own (must settle it)
            yield* Effect.forkChild(
              kernel.events.pipe(
                Stream.filter((event) => event.type === "run.parked"),
                Stream.take(1),
                Stream.runForEach(() =>
                  Effect.andThen(
                    bus.publish(IssueClosed, { number: 99, by: "neighbor" }),
                    bus.publish(IssueClosed, { number: 7, by: "maintainer" }),
                  ),
                ),
              ),
            );

            const running = yield* Effect.forkChild(work.dispatch("triage #7"));
            return (yield* Fiber.join(running)) as {
              number: number;
              by: string;
            };
          }),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              AI.memory.pipe(
                Layer.provide([
                  scripted([
                    { type: "text-start", id: "t" } as never,
                    { type: "text-delta", id: "t", delta: "looking" } as never,
                    { type: "text-end", id: "t" } as never,
                    finish("stop"),
                  ]),
                  AI.EventBusMemory,
                ]),
              ),
              AI.EventBusMemory,
              Layer.succeed(CloseIssue, (() =>
                Effect.succeed("closed")) as never),
              RuntimeContext.phantom,
            ),
          ),
        );

        // the neighbor's close (#99) was observed and IGNORED; only the
        // correlated event (#7) settled the run — and it is the payload
        expect(outcome).toEqual({ number: 7, by: "maintainer" });
      }),
  );

  it.effect(
    "key default: NO match callback — the source's key correlates the run",
    () =>
      Effect.gen(function* () {
        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const bus = yield* AI.EventBus;
            const work = yield* kernel.interpret(KeyDefaultIssueWork);

            // when the run parks, close a DIFFERENT issue first (must
            // not settle it — its key is #99, the item's is #7), then
            // the run's own (must settle it): the catalog-owned key is
            // the correlation, no charter callback anywhere
            yield* Effect.forkChild(
              kernel.events.pipe(
                Stream.filter((event) => event.type === "run.parked"),
                Stream.take(1),
                Stream.runForEach(() =>
                  Effect.andThen(
                    bus.publish(KeyedIssueClosed, {
                      number: 99,
                      by: "neighbor",
                    }),
                    bus.publish(KeyedIssueClosed, {
                      number: 7,
                      by: "maintainer",
                    }),
                  ),
                ),
              ),
            );

            // the work item shares the event's key shape: key(item) = #7
            const running = yield* Effect.forkChild(
              work.dispatch({ number: 7, by: "reporter" }),
            );
            return (yield* Fiber.join(running)) as {
              number: number;
              by: string;
            };
          }),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              AI.memory.pipe(
                Layer.provide([
                  scripted([
                    { type: "text-start", id: "t" } as never,
                    { type: "text-delta", id: "t", delta: "looking" } as never,
                    { type: "text-end", id: "t" } as never,
                    finish("stop"),
                  ]),
                  AI.EventBusMemory,
                ]),
              ),
              AI.EventBusMemory,
              Layer.succeed(CloseIssue, (() =>
                Effect.succeed("closed")) as never),
              RuntimeContext.phantom,
            ),
          ),
        );

        // the neighbor's close (#99) was IGNORED by key inequality;
        // only the item's own key (#7) settled the run
        expect(outcome).toEqual({ number: 7, by: "maintainer" });
      }),
  );

  it.effect(
    "steer(runKey, msg) wakes the parked run for another work round",
    () =>
      Effect.gen(function* () {
        // turn 1: the model just looks (no close) — the run parks.
        // turn 2 (after the keyed steer): the model closes the issue.
        let turn = 0;
        const model = Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: () => Effect.die(new Error("streamText only")),
            streamText: () =>
              Stream.suspend(() =>
                Stream.fromIterable(
                  ++turn === 1
                    ? [
                        { type: "text-start", id: "t" } as never,
                        {
                          type: "text-delta",
                          id: "t",
                          delta: "waiting for verification",
                        } as never,
                        { type: "text-end", id: "t" } as never,
                        finish("stop"),
                      ]
                    : [
                        toolCall("c1", "close_issue", { number: 7 }),
                        finish("tool-calls"),
                      ],
                ),
              ),
          }),
        );

        const { outcome, types } = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const work = yield* kernel.interpret(IssueWork);

            // the front door learns the run key from the run.admitted
            // row and steers THAT run once it parks. Buffer the firehose
            // BEFORE admitting so the admission row is never missed.
            const events = yield* Stream.toQueue(kernel.events, {
              capacity: "unbounded",
            });
            yield* Effect.yieldNow;
            yield* Effect.forkChild(
              Effect.gen(function* () {
                let runKey: string | undefined;
                yield* Stream.fromQueue(events).pipe(
                  Stream.tap((event) =>
                    Effect.sync(() => {
                      if (event.type === "run.admitted") {
                        runKey = event.session;
                      }
                    }),
                  ),
                  Stream.filter((event) => event.type === "run.parked"),
                  Stream.take(1),
                  Stream.runForEach(() =>
                    work.steer(
                      runKey!,
                      "the fix is verified — close issue #7 now",
                    ),
                  ),
                );
              }),
            );

            const value = (yield* work.dispatch("work issue #7")) as {
              number: number;
              by: string;
            };
            const trace = yield* Stream.runCollect(
              kernel
                .trace("IssueWork")
                .pipe(Stream.takeUntil((e) => e.type === "run.settled")),
            );
            return { outcome: value, types: [...trace].map((e) => e.type) };
          }),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              AI.memory.pipe(Layer.provide([model, AI.EventBusMemory])),
              AI.EventBusMemory,
              // the close tool publishes the world event, as before
              Layer.succeed(CloseIssue, ((input: { number: number }) =>
                Effect.gen(function* () {
                  const bus = yield* AI.EventBus;
                  yield* bus.publish(IssueClosed, {
                    number: input.number,
                    by: "agent",
                  });
                  return "closed";
                })) as never).pipe(Layer.provide(AI.EventBusMemory)),
              RuntimeContext.phantom,
            ),
          ),
        );

        // the steered second round closed the issue; the world event
        // settled the run
        expect(outcome).toEqual({ number: 7, by: "agent" });
        // the wake is a durable fact: parked, steered awake, resolved
        expect(types).toContain("run.parked");
        expect(types).toContain("run.steered");
        expect(types).toContain("run.resolved");
      }),
  );
});
