/**
 * The memory kernel against a REAL model (Anthropic, `claude-haiku-4-5`)
 * — the smallest live slice: one agent, one tool, one dispatch. Proves
 * the interpretation pipeline end to end outside of scripts: the
 * rendered charter steers the model, the advertised schema round-trips
 * through Anthropic's tool-use API, the kernel executes the tool
 * (`disableToolCallResolution`), and the kernel-default halt fires.
 *
 * Gated on `ANTHROPIC_API_KEY` — skips cleanly when unset:
 *
 *   ANTHROPIC_API_KEY=sk-… bun vitest run test/AI/KernelLive.test.ts
 */
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient";
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as S from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as AI from "@/AI/index.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";

const apiKey = process.env.ANTHROPIC_API_KEY;

// ─── the org: one agent, one tool ────────────────────────────────

const a = AI.Parameter("a", S.Number)`the left operand`;
const b = AI.Parameter("b", S.Number)`the right operand`;

class Multiply extends AI.Tool<Multiply>()("multiply")`
Multiply ${a} by ${b} and return the product. Arithmetic in your head
is forbidden — always use this tool.` {}

class Mathematician extends AI.Agent<Mathematician>()("Mathematician")`
You are a careful mathematician. You never do arithmetic yourself:
use ${Multiply} for every multiplication, then state the result as
plain digits (no thousands separators).` {}

class Compute extends AI.Loop<Compute>()("Compute")`
You compute arithmetic expressions step by step. You never do
arithmetic yourself: use ${Multiply} for every single multiplication,
one call per step.
${AI.until(S.Struct({ answer: S.Number }))`the expression is fully computed`}
${AI.budget({ iterations: 6 })}` {}

class Chief extends AI.Agent<Chief>()("Chief")`
You are a chief of staff who cannot do arithmetic at all. For any
arithmetic question, delegate the ENTIRE question to ${Mathematician}
verbatim, then repeat its final answer as plain digits.` {}

// ─── physics ─────────────────────────────────────────────────────

const ModelLive = AnthropicLanguageModel.layer({
  model: "claude-haiku-4-5",
}).pipe(
  Layer.provide(
    AnthropicClient.layer({
      apiKey: apiKey === undefined ? undefined : Redacted.make(apiKey),
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
);

/** Per-test harness: a private invocation capture (tests run concurrently). */
const makeHarness = () => {
  const invocations: Array<{ a: number; b: number }> = [];
  const layer = Layer.mergeAll(
    AI.memory.pipe(Layer.provide(ModelLive)),
    Layer.succeed(Multiply, ((input: { a: number; b: number }) =>
      Effect.sync(() => {
        invocations.push(input);
        return { product: input.a * input.b };
      })) as never),
    RuntimeContext.phantom,
  );
  return { layer, invocations };
};

// ─── the test ────────────────────────────────────────────────────

describe("memory kernel × live Anthropic", () => {
  it.effect.skipIf(apiKey === undefined)(
    "one agent, one tool, one dispatch",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const mathematician = yield* kernel.interpret(Mathematician);
            return (yield* mathematician.dispatch(
              "What is 1234 multiplied by 5678?",
            )) as AI.Step.HaltOutcome;
          }),
        ).pipe(Effect.provide(harness.layer));

        // the model used OUR tool (executed by the kernel, not effect/ai)
        expect(harness.invocations).toEqual([{ a: 1234, b: 5678 }]);
        // the kernel-default halt fired and the answer came back
        expect(outcome._tag).toBe("Completed");
        if (outcome._tag === "Completed") {
          expect(outcome.text).toContain("7006652");
        }
      }),
    { timeout: 60_000 },
  );

  it.effect.skipIf(apiKey === undefined)(
    "a real token ceiling halts the turn with real usage counts",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        // 1 token can never cover round 2: the first (real) wire call
        // lands, its usage decrements the budget transactionally, and the
        // ceiling fires before the second call is paid for
        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const mathematician = yield* kernel.interpret(Mathematician);
            return (yield* mathematician.dispatch(
              "What is 87 multiplied by 93?",
            )) as AI.Step.HaltOutcome;
          }),
        ).pipe(
          Effect.provide(harness.layer),
          Effect.provide(
            Layer.succeed(AI.KernelPolicy, { maxModelCalls: 24, maxTokens: 1 }),
          ),
        );

        expect(outcome._tag).toBe("BudgetExceeded");
        if (outcome._tag === "BudgetExceeded") {
          expect(outcome.limit).toBe("tokens");
          expect(outcome.budget).toBe(1);
          // real Anthropic usage was counted, not estimated
          expect(outcome.used).toBeGreaterThan(100);
          expect(outcome.unknownUsage).toBe(0);
        }
        // the model did reach for the tool before the ceiling cut it off
        expect(harness.invocations).toEqual([{ a: 87, b: 93 }]);
      }),
    { timeout: 60_000 },
  );

  it.effect.skipIf(apiKey === undefined)(
    "real streaming: deltas hit the firehose live, the trace stays durable",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const { events, trace } = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const mathematician = yield* kernel.interpret(Mathematician);
            // subscribe to the firehose BEFORE dispatching
            const firehose = yield* Effect.forkChild(
              Stream.runCollect(
                kernel.events.pipe(
                  Stream.takeUntil((event) => event.type === "turn.halted"),
                ),
              ),
            );
            yield* Effect.yieldNow;
            yield* mathematician.dispatch("What is 12 multiplied by 34?");
            const events = yield* Fiber.join(firehose);
            const trace = yield* Stream.runCollect(
              kernel
                .trace("Mathematician")
                .pipe(
                  Stream.takeUntil((event) => event.type === "turn.halted"),
                ),
            );
            return { events, trace };
          }),
        ).pipe(Effect.provide(harness.layer));

        // Anthropic really streamed: text arrived as live deltas
        const deltas = events.filter((event) => event.type === "model.delta");
        expect(deltas.length).toBeGreaterThan(0);
        for (const delta of deltas) {
          expect(delta.durable).toBe(false);
          expect(delta.seq).toBeUndefined();
          expect(typeof (delta.payload as any).delta).toBe("string");
        }
        // reassembling the deltas reproduces the final answer text
        const streamed = deltas
          .map((event) => (event.payload as any).delta as string)
          .join("");
        expect(streamed).toContain("408");
        // the durable trace never saw a delta, and its cursor is contiguous
        expect(trace.every((event) => event.type !== "model.delta")).toBe(true);
        expect(trace.map((event) => event.seq)).toEqual(
          trace.map((_, index) => index + 1),
        );
      }),
    { timeout: 60_000 },
  );

  it.effect.skipIf(apiKey === undefined)(
    "a mid-turn steer changes the model's course at the next boundary",
    () =>
      Effect.gen(function* () {
        const steerRef: {
          current?: (input: unknown) => Effect.Effect<void, never, any>;
        } = {};
        // the multiply tool steers its own agent mid-turn: by the time the
        // model composes its final answer (round 2), the steer is promoted
        const steeringLayer = Layer.mergeAll(
          AI.memory.pipe(Layer.provide(ModelLive)),
          Layer.succeed(Multiply, ((input: { a: number; b: number }) =>
            steerRef.current!(
              "IMPORTANT change of plan: include the word 'pineapple' somewhere in your final answer.",
            ).pipe(Effect.as({ product: input.a * input.b }))) as never),
          RuntimeContext.phantom,
        );

        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const mathematician = yield* kernel.interpret(Mathematician);
            steerRef.current = (input) => mathematician.steer(input);
            return (yield* mathematician.dispatch(
              "What is 19 multiplied by 21?",
            )) as AI.Step.HaltOutcome;
          }),
        ).pipe(Effect.provide(steeringLayer));

        expect(outcome._tag).toBe("Completed");
        if (outcome._tag === "Completed") {
          // the model saw the steer at the round-2 boundary and obeyed
          expect(outcome.text.toLowerCase()).toContain("pineapple");
          expect(outcome.text).toContain("399");
        }
      }),
    { timeout: 60_000 },
  );

  it.effect.skipIf(apiKey === undefined)(
    "interrupt halts a real turn before the next round is paid for",
    () =>
      Effect.gen(function* () {
        const interruptRef: {
          current?: () => Effect.Effect<void, never, any>;
        } = {};
        const layer = Layer.mergeAll(
          AI.memory.pipe(Layer.provide(ModelLive)),
          // the tool interrupts its own agent: the settled result folds in,
          // round 2 is never paid for, and the turn halts as Interrupted
          Layer.succeed(Multiply, ((input: { a: number; b: number }) =>
            interruptRef.current!().pipe(
              Effect.as({ product: input.a * input.b }),
            )) as never),
          RuntimeContext.phantom,
        );

        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const mathematician = yield* kernel.interpret(Mathematician);
            interruptRef.current = () => mathematician.interrupt();
            return (yield* mathematician.dispatch(
              "What is 55 multiplied by 89?",
            )) as AI.Step.HaltOutcome;
          }),
        ).pipe(Effect.provide(layer));

        // no Completed answer — the turn ended as a settled interruption
        expect(outcome).toMatchObject({ _tag: "Interrupted", abandoned: [] });
      }),
    { timeout: 60_000 },
  );

  it.effect.skipIf(apiKey === undefined)(
    "a real Loop run: iterated tool use, resolved via halt-as-tool",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const compute = yield* kernel.interpret(Compute);
            // (3 × 4) × 5 forces two dependent multiply calls before the
            // model can resolve with the typed answer
            return yield* compute.dispatch(
              "Compute (3 * 4) * 5 and resolve with the final answer.",
            );
          }),
        ).pipe(Effect.provide(harness.layer));

        // the typed halt value came back through resolve
        expect(result).toEqual({ answer: 60 });
        // both real multiplications went through OUR tool
        expect(harness.invocations).toContainEqual({ a: 3, b: 4 });
        expect(harness.invocations).toContainEqual({ a: 12, b: 5 });
      }),
    { timeout: 120_000 },
  );

  it.effect.skipIf(apiKey === undefined)(
    "delegation: Chief → Mathematician → multiply, distilled back up",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const kernelLayer = AI.memory.pipe(Layer.provide(ModelLive));
        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const chief = yield* kernel.interpret(Chief);
            return (yield* chief.dispatch(
              "What is 63 multiplied by 127?",
            )) as AI.Step.HaltOutcome;
          }),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              kernelLayer,
              AI.layer(Mathematician).pipe(
                Layer.provide([
                  kernelLayer,
                  harness.layer,
                  RuntimeContext.phantom,
                ]),
              ),
              RuntimeContext.phantom,
            ),
          ),
        );

        // the full chain ran: Chief delegated, the Mathematician used the
        // real tool, and the distilled answer came back up
        expect(harness.invocations).toContainEqual({ a: 63, b: 127 });
        expect(outcome._tag).toBe("Completed");
        if (outcome._tag === "Completed") {
          expect(outcome.text).toContain("8001");
        }
      }),
    { timeout: 120_000 },
  );

  it.effect.skipIf(apiKey === undefined)(
    "the live turn journals its Trace write-ahead (§2.7)",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const trace = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const mathematician = yield* kernel.interpret(Mathematician);
            yield* mathematician.dispatch("What is 41 multiplied by 271?");
            return yield* Stream.runCollect(
              kernel
                .trace("Mathematician")
                .pipe(
                  Stream.takeUntil((event) => event.type === "turn.halted"),
                ),
            );
          }),
        ).pipe(Effect.provide(harness.layer));

        const types = trace.map((event) => event.type);
        // the turn opens with a journaled intent and closes with the halt
        expect(types[0]).toBe("model.requested");
        expect(types[types.length - 1]).toBe("turn.halted");
        // the real tool call was journaled: intent before terminal
        expect(types.indexOf("tool.requested")).toBeGreaterThan(-1);
        expect(types.indexOf("tool.requested")).toBeLessThan(
          types.indexOf("tool.completed"),
        );
        // every wire call has a terminal carrying real Usage tokens
        const completions = trace.filter((e) => e.type === "model.completed");
        expect(completions.length).toBeGreaterThan(0);
        for (const completion of completions) {
          const usage = (completion.payload as any).usage;
          expect(usage.inputTokens.total).toBeGreaterThan(0);
        }
        // the durable cursor is contiguous from 1
        expect(trace.map((event) => event.seq)).toEqual(
          trace.map((_, index) => index + 1),
        );
      }),
    { timeout: 60_000 },
  );
});
