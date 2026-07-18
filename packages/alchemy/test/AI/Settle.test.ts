/**
 * Externally-settled runs (kernel-pruning ruling, 2026-07-17): a charter
 * with NO halt parks after each work round; the COMPONENT — the
 * implementation Layer that consumed the wire — ends the run with
 * `settle(key, event)`. The kernel just runs the loop; it subscribes to
 * nothing. Correlation IS the key the run was admitted under
 * (`dispatch(item, { key })` / `send(item, { key })`). The model may
 * CAUSE the world's event (closing the issue with a tool), but the run
 * resolves on the component DELIVERING it — reconciler doctrine:
 * observation > claim.
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

const number = AI.Parameter("number", S.Number)`the issue number`;
class CloseIssue extends AI.Tool<CloseIssue>()("close_issue")`
Close issue ${number} once it is resolved.` {}

// NO halt: the run is externally settled — its ending is prose, its
// `Out` is unknown (the settled event's type is the component's
// knowledge, not the charter's)
class IssueWork extends AI.Process<IssueWork>()("IssueWork")`
Work the issue. Close it with ${CloseIssue} when done. GitHub closing
the issue is what ends this work — you never declare it done yourself.` {}

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

const lookingModel = scripted([
  { type: "text-start", id: "t" } as never,
  { type: "text-delta", id: "t", delta: "looking" } as never,
  { type: "text-end", id: "t" } as never,
  finish("stop"),
]);

const baseLayers = (model: Layer.Layer<LanguageModel.LanguageModel>) =>
  Layer.mergeAll(
    AI.memory.pipe(Layer.provide(model)),
    Layer.succeed(CloseIssue, (() => Effect.succeed("closed")) as never),
    RuntimeContext.phantom,
  );

describe("externally-settled runs — the component owns the exit", () => {
  it.effect(
    "the run parks after its work round; settle(key, event) resolves it",
    () =>
      Effect.gen(function* () {
        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const work = yield* kernel.interpret(IssueWork);

            // the "component": when the run parks, the world's close is
            // DELIVERED by key — exactly what a drive loop does after
            // `Match.tag("IssueClosed", …)`
            yield* Effect.forkChild(
              kernel.events.pipe(
                Stream.filter((event) => event.type === "run.parked"),
                Stream.take(1),
                Stream.runForEach(() =>
                  work.settle("#7", { number: 7, by: "maintainer" }),
                ),
              ),
            );

            const running = yield* Effect.forkChild(
              work.dispatch("triage #7", { key: "#7" }),
            );
            return (yield* Fiber.join(running)) as { by: string };
          }),
        ).pipe(Effect.provide(baseLayers(lookingModel)));

        // Out is the DELIVERED event, not a model claim
        expect(outcome.by).toBe("maintainer");
      }),
  );

  it.effect(
    "settle addresses by key: a neighbor's close never ends this run",
    () =>
      Effect.gen(function* () {
        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const work = yield* kernel.interpret(IssueWork);

            // when the run parks: settle a key NOBODY holds (an
            // idempotent no-op — the world may speak about runs we
            // never admitted), then the run's own key
            yield* Effect.forkChild(
              kernel.events.pipe(
                Stream.filter((event) => event.type === "run.parked"),
                Stream.take(1),
                Stream.runForEach(() =>
                  Effect.andThen(
                    work.settle("#99", { number: 99, by: "neighbor" }),
                    work.settle("#7", { number: 7, by: "maintainer" }),
                  ),
                ),
              ),
            );

            const running = yield* Effect.forkChild(
              work.dispatch("triage #7", { key: "#7" }),
            );
            return (yield* Fiber.join(running)) as {
              number: number;
              by: string;
            };
          }),
        ).pipe(Effect.provide(baseLayers(lookingModel)));

        expect(outcome).toEqual({ number: 7, by: "maintainer" });
      }),
  );

  it.effect(
    "the model's tool may CAUSE the event; the component still delivers it",
    () =>
      Effect.gen(function* () {
        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const work = yield* kernel.interpret(IssueWork);

            // the close tool's physics acts on the world; the component
            // (here: the harness watching the world) delivers the close
            // back to the run — cause and settlement stay separate
            yield* Effect.forkChild(
              kernel.events.pipe(
                Stream.filter((event) => event.type === "run.parked"),
                Stream.take(1),
                Stream.runForEach(() =>
                  work.settle("#42", { number: 42, by: "agent" }),
                ),
              ),
            );

            return (yield* work.dispatch("fix the bug in #42", {
              key: "#42",
            })) as { number: number; by: string };
          }),
        ).pipe(
          Effect.provide(
            baseLayers(
              scripted([
                toolCall("c1", "close_issue", { number: 42 }),
                finish("tool-calls"),
              ]),
            ),
          ),
        );

        expect(outcome).toEqual({ number: 42, by: "agent" });
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

            // the component steers THIS run once it parks (round 2's
            // input), then settles it after the second park — the loop
            // is: round, park, steer, round, park, settle
            let parks = 0;
            yield* Effect.forkChild(
              kernel.events.pipe(
                Stream.filter((event) => event.type === "run.parked"),
                Stream.take(2),
                Stream.runForEach(() =>
                  ++parks === 1
                    ? work.steer(
                        "#7",
                        "the fix is verified — close issue #7 now",
                      )
                    : work.settle("#7", { number: 7, by: "maintainer" }),
                ),
              ),
            );

            const value = (yield* work.dispatch("work issue #7", {
              key: "#7",
            })) as { number: number; by: string };
            const trace = yield* Stream.runCollect(
              kernel
                .trace("IssueWork")
                .pipe(Stream.takeUntil((e) => e.type === "run.settled")),
            );
            return { outcome: value, types: [...trace].map((e) => e.type) };
          }),
        ).pipe(Effect.provide(baseLayers(model)));

        expect(outcome).toEqual({ number: 7, by: "maintainer" });
        // the loop is visible in the Trace: park → steer → park → resolve
        expect(types).toContain("run.parked");
        expect(types).toContain("run.steered");
        expect(types).toContain("run.resolved");
      }),
  );
});
