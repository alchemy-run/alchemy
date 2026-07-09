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
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { makeChatSessions } from "@/AI/Api/ChatSessions.ts";
import { sessionEvents, toChunks } from "@/AI/Api/Chunks.ts";
import { sseFrame } from "@/AI/Api/Protocol.ts";
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

class Auditor extends AI.Agent<Auditor>()("Auditor")`
You are a strict auditor. Verify claims independently and answer in
EXACTLY the JSON format you are asked for — nothing else.` {}

class AuditedCompute extends AI.Loop<AuditedCompute>()("AuditedCompute")`
You compute arithmetic expressions step by step. Use ${Multiply} for
every single multiplication, one call per step.
${AI.until(S.Struct({ answer: S.Number }))`the expression is fully computed`}
${AI.check(Auditor)`re-derive the arithmetic yourself and accept only an exactly correct answer`}
${AI.budget({ iterations: 6 })}` {}

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
    "spawn-and-continue: a background delegation steers its result back",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const kernelLayer = AI.memory.pipe(Layer.provide(ModelLive));
        const layers = Layer.mergeAll(
          kernelLayer,
          AI.layer(Mathematician).pipe(
            Layer.provide([kernelLayer, harness.layer, RuntimeContext.phantom]),
          ),
          RuntimeContext.phantom,
        );
        const { first, second } = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const chief = yield* kernel.interpret(Chief);
            const first = (yield* chief.dispatch(
              "Delegate this to Mathematician with background=true, then " +
                "immediately end your turn by replying exactly 'spawned': " +
                "What is 21 multiplied by 47?",
            )) as AI.Step.HaltOutcome;
            // rows are truth: wait for the delegate's run to halt
            yield* Stream.runCollect(
              kernel
                .trace("Mathematician")
                .pipe(
                  Stream.takeUntil((event) => event.type === "turn.halted"),
                ),
            ).pipe(Effect.timeout("60 seconds"), Effect.orDie);
            // the parked completion steer enters this turn's round 1
            const second = (yield* chief.dispatch(
              "What did the background run report? Answer with the number.",
            )) as AI.Step.HaltOutcome;
            return { first, second };
          }),
        ).pipe(Effect.provide(layers));

        // the spawn returned immediately (no result in turn 1)…
        expect(first._tag).toBe("Completed");
        if (first._tag === "Completed") {
          expect(first.text).not.toContain("987");
        }
        // …the delegate really ran the tool in the background…
        expect(harness.invocations).toContainEqual({ a: 21, b: 47 });
        // …and the steered-back result reached turn 2
        expect(second._tag).toBe("Completed");
        if (second._tag === "Completed") {
          expect(second.text).toContain("987");
        }
      }),
    { timeout: 180_000 },
  );

  // it.live: this test sleeps on the real clock (the hanging tool and the
  // poll schedule would freeze forever under it.effect's TestClock)
  it.live.skipIf(apiKey === undefined)(
    "interrupt cascades: cancelling the Chief frees a stuck Mathematician",
    () =>
      Effect.gen(function* () {
        // the delegate's multiply hangs for 60s — an interrupt on the
        // PARENT must fiber-interrupt it through both rings, long before
        // the hang resolves on its own
        const invocations: Array<{ a: number; b: number }> = [];
        const HangingMultiply = Layer.succeed(Multiply, ((input: {
          a: number;
          b: number;
        }) =>
          Effect.gen(function* () {
            invocations.push(input);
            yield* Effect.sleep("60 seconds");
            return { product: input.a * input.b };
          })) as never);

        const kernelLayer = AI.memory.pipe(Layer.provide(ModelLive));
        const { outcome, mathHalt, elapsed } = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const chief = yield* kernel.interpret(Chief);
            const startedAt = Date.now();
            const running = yield* Effect.forkChild(
              chief.dispatch("What is 33 multiplied by 77?"),
            );
            // wait until the delegate is genuinely stuck in the tool
            yield* Effect.repeat(
              Effect.sync(() => invocations.length),
              {
                schedule: Schedule.spaced("250 millis"),
                until: (count) => count > 0,
                times: 120,
              },
            );
            yield* chief.interrupt();
            const outcome = (yield* Fiber.join(running)) as AI.Step.HaltOutcome;
            const elapsed = Date.now() - startedAt;
            const mathTrace = yield* Stream.runCollect(
              kernel
                .trace("Mathematician")
                .pipe(
                  Stream.takeUntil((event) => event.type === "turn.halted"),
                ),
            );
            return {
              outcome,
              mathHalt: mathTrace[mathTrace.length - 1]!,
              elapsed,
            };
          }),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              kernelLayer,
              AI.layer(Mathematician).pipe(
                Layer.provide([
                  kernelLayer,
                  HangingMultiply,
                  RuntimeContext.phantom,
                ]),
              ),
              RuntimeContext.phantom,
            ),
          ),
        );

        // the parent settled as Interrupted…
        expect(outcome._tag).toBe("Interrupted");
        // …the cascade reached the delegate's ring…
        expect((mathHalt.payload as any).outcome).toBe("Interrupted");
        // …and nobody waited out the 60s hang
        expect(elapsed).toBeLessThan(45_000);
      }),
    { timeout: 120_000 },
  );

  // it.live: the pending-ask poll runs on the real clock
  it.live.skipIf(apiKey === undefined)(
    "the Ask protocol: a real turn parks on approval and resumes on the verdict",
    () =>
      Effect.gen(function* () {
        const approvalAction = AI.Parameter(
          "approvalAction",
          S.String,
        )`the action needing approval`;
        class RequestApproval extends AI.Tool<RequestApproval>()(
          "request_approval",
        )`Request human approval for ${approvalAction}. Blocks until a
decision arrives. Never act without it.` {}
        class Launcher extends AI.Agent<Launcher>()("Launcher")`
You launch rockets. Before ANY launch you MUST call
${RequestApproval} and obey the verdict exactly. Report the final
status in one short sentence.` {}

        const ApprovalViaAsk = Layer.succeed(RequestApproval, ((input: {
          approvalAction: string;
        }) =>
          Effect.gen(function* () {
            const ask = yield* AI.Ask;
            const answer = yield* ask({
              kind: "approval",
              text: input.approvalAction,
            });
            if (answer.verdict !== "approved") {
              return yield* Effect.fail(
                `denied: ${answer.text ?? "no reason given"}`,
              );
            }
            return "approved — proceed";
          })) as never);

        const { pending, outcome } = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const hub = yield* AI.AskHub;
            const launcher = yield* kernel.interpret(Launcher);
            const running = yield* Effect.forkChild(
              launcher.dispatch("Launch the rocket named Dandelion."),
            );
            const pending = yield* hub.pending.pipe(
              Effect.repeat({
                schedule: Schedule.spaced("500 millis"),
                until: (asks) => asks.length > 0,
                times: 120,
              }),
            );
            yield* hub.answer(pending[0]!.id, { verdict: "approved" });
            const outcome = (yield* Fiber.join(running)) as AI.Step.HaltOutcome;
            return { pending, outcome };
          }),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              AI.memory.pipe(Layer.provide([ModelLive, AI.AskHubMemory])),
              AI.AskHubMemory,
              ApprovalViaAsk,
              RuntimeContext.phantom,
            ),
          ),
        );

        // the model really parked: the ask was visible from the world side
        expect(pending[0]!.ring).toBe("Launcher");
        expect((pending[0]!.payload as AI.AskPayload).kind).toBe("approval");
        // and the verdict let the turn complete
        expect(outcome._tag).toBe("Completed");
        if (outcome._tag === "Completed") {
          expect(outcome.text.toLowerCase()).toMatch(/launch|dandelion/);
        }
      }),
    { timeout: 120_000 },
  );

  it.effect.skipIf(apiKey === undefined)(
    "AI.check: a real judge ratifies a real loop's claim",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const kernelLayer = AI.memory.pipe(Layer.provide(ModelLive));
        const { value, trace } = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const compute = yield* kernel.interpret(AuditedCompute);
            const value = yield* compute.dispatch(
              "Compute 7 * 8 and resolve with the final answer.",
            );
            const trace = yield* Stream.runCollect(
              kernel
                .trace("AuditedCompute")
                .pipe(
                  Stream.takeUntil((event) => event.type === "run.resolved"),
                ),
            );
            return { value, trace };
          }),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              kernelLayer,
              harness.layer,
              AI.layer(Auditor).pipe(
                Layer.provide([kernelLayer, RuntimeContext.phantom]),
              ),
              RuntimeContext.phantom,
            ),
          ),
        );

        // the claim was graded before it was believed: the verdict row
        // precedes the acceptance in the loop's own Trace
        const types = trace.map((event) => event.type);
        expect(types).toContain("check.requested");
        expect(types.indexOf("check.verdict")).toBeLessThan(
          types.indexOf("run.resolved"),
        );
        const verdict = trace.find((event) => event.type === "check.verdict")!;
        expect((verdict.payload as any).verdict).toBe("goal-met");
        // and the ratified value is correct
        expect(value).toEqual({ answer: 56 });
        expect(harness.invocations).toContainEqual({ a: 7, b: 8 });
      }),
    { timeout: 120_000 },
  );

  // it.live: run() + the poll wait on the real clock
  it.live.skipIf(apiKey === undefined)(
    "the trigger runtime: a world event wakes a perpetual ring",
    () =>
      Effect.gen(function* () {
        const Alarm = AI.EventSource(
          "live.alarm",
          S.Struct({ question: S.String }),
        );
        const note = AI.Parameter("note", S.String)`your answer, tersely`;
        class LogAnswer extends AI.Tool<LogAnswer>()("log_answer")`
Log ${note} as the answer to the work item. Call exactly once per item.` {}
        class NightWatch extends AI.Loop<NightWatch>()("NightWatch")`
You answer questions that arrive as work items. For each item, compute
the answer and call ${LogAnswer} with it, then stop.
${AI.on(Alarm)}
${AI.never`health = one log_answer call per alarm`}` {}

        const logged: string[] = [];
        const LogLive = Layer.succeed(LogAnswer, ((input: { note: string }) =>
          Effect.sync(() => {
            logged.push(input.note);
            return "logged";
          })) as never);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const bus = yield* AI.EventBus;
            const watch = yield* kernel.interpret(NightWatch);
            yield* Effect.forkChild(watch.run());
            yield* Effect.sleep("100 millis");
            // the world rings the alarm
            yield* bus.publish(Alarm, {
              question: "What is 25 multiplied by 4? Answer in plain digits.",
            });
            yield* Effect.repeat(
              Effect.sync(() => logged.length),
              {
                schedule: Schedule.spaced("500 millis"),
                until: (count) => count > 0,
                times: 120,
              },
            );
          }),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              AI.memory.pipe(Layer.provide([ModelLive, AI.EventBusMemory])),
              AI.EventBusMemory,
              LogLive,
              RuntimeContext.phantom,
            ),
          ),
        );

        // the event woke the ring; the model served it and logged the answer
        expect(logged.length).toBeGreaterThan(0);
        expect(logged[0]).toContain("100");
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
        // the run opens with its durable admission (the work item is a
        // fact), then the journaled intent, and closes with the halt
        expect(types[0]).toBe("run.admitted");
        expect(types[1]).toBe("model.requested");
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

  it.effect.skipIf(apiKey === undefined)(
    "a live turn's trace folds into a valid UI message stream",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const trace = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const mathematician = yield* kernel.interpret(Mathematician);
            yield* mathematician.dispatch("What is 19 multiplied by 21?");
            return yield* Stream.runCollect(
              kernel
                .trace("Mathematician")
                .pipe(
                  Stream.takeUntil((event) => event.type === "turn.halted"),
                ),
            );
          }),
        ).pipe(Effect.provide(harness.layer));

        const session = trace.find((e) => e.type === "run.admitted")!.session!;
        const chunks = yield* Stream.runCollect(
          toChunks(sessionEvents(Stream.fromIterable(trace), session)),
        );

        // the protocol envelope
        expect(chunks[0]!.type).toBe("start");
        expect(chunks[chunks.length - 1]!.type).toBe("finish");
        // the real tool call rendered as protocol parts with payloads
        const input = chunks.find((c) => c.type === "tool-input-available")!;
        expect((input as { toolName: string }).toolName).toBe("multiply");
        expect((input as { input: unknown }).input).toEqual({ a: 19, b: 21 });
        const output = chunks.find((c) => c.type === "tool-output-available")!;
        expect((output as { output: { product: number } }).output.product).toBe(
          399,
        );
        // replay reconstructed the assistant text from the halt row
        const text = chunks
          .filter((c) => c.type === "text-delta")
          .map((c) => (c as { delta: string }).delta)
          .join("");
        expect(text).toContain("399");
        // and every chunk survives the golden wire encoding
        for (const chunk of chunks) expect(sseFrame(chunk)).toContain("data: ");
      }),
    { timeout: 60_000 },
  );

  it.effect.skipIf(apiKey === undefined)(
    "ChatSessions serves a live two-message conversation",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const transcript = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const mathematician = yield* kernel.interpret(Mathematician);
            const sessions = yield* makeChatSessions({
              process: mathematician,
            });

            const message = (id: string, text: string) =>
              ({
                id,
                role: "user",
                parts: [{ type: "text", text }],
              }) as const;

            yield* Stream.runDrain(
              sessions.send(
                "conv-live",
                message("u1", "What is 12 multiplied by 12?"),
              ),
            );
            yield* Stream.runDrain(
              sessions.send("conv-live", message("u2", "Now multiply 7 by 6.")),
            );
            return yield* sessions.transcript("conv-live");
          }),
        ).pipe(Effect.provide([harness.layer, AI.AskHubMemory]));

        // both exchanges materialized, in order
        expect(transcript.map((m) => m.role)).toEqual([
          "user",
          "assistant",
          "user",
          "assistant",
        ]);
        const textOf = (m: (typeof transcript)[number]) =>
          m.parts
            .filter((p) => p.type === "text")
            .map((p) => String(p.text))
            .join("");
        expect(textOf(transcript[1]!)).toContain("144");
        expect(textOf(transcript[3]!)).toContain("42");
        // the real tool was invoked through the serving path
        expect(harness.invocations).toContainEqual({ a: 12, b: 12 });
        expect(harness.invocations).toContainEqual({ a: 7, b: 6 });
      }),
    { timeout: 120_000 },
  );
});
