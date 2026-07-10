/**
 * Machine-observed exits (reassess §B): `AI.until(eventSource)` — the
 * WORLD declares the run's end, not the model's `resolve` claim. The
 * run does one work round, then settles when a matching event arrives
 * on the source (the model may CAUSE it by calling a tool, or a human
 * may). Reconciler doctrine: observation > claim.
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

const number = AI.Parameter("number", S.Number)`the issue number`;
class CloseIssue extends AI.Tool<CloseIssue>()("close_issue")`
Close issue ${number} once it is resolved.` {}

class IssueWork extends AI.Process<IssueWork>()("IssueWork")`
Work the issue. Close it with ${CloseIssue} when done.
${AI.until(IssueClosed)}` {}

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

describe("AI.until(eventSource) — machine-observed exit", () => {
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
});
