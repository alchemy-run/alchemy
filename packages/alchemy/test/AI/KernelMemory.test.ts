/**
 * End-to-end tests for the in-memory reference Kernel (design §2.6):
 * an Agent term is interpreted against a *scripted* LanguageModel — no
 * network — proving the full pipeline: template → system prompt, tool
 * refs → advertised toolkit, kernel-owned tool execution
 * (disableToolCallResolution), model-visible tool failures, and the
 * kernel-default halt.
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

// ─── a tiny org: one agent, one tool ─────────────────────────────

const pattern = AI.Parameter("pattern", S.String)`the regex to search for`;

class Grep extends AI.Tool<Grep>()("grep")`
Search the corpus for ${pattern}.` {}

class Librarian extends AI.Agent<Librarian>()("Librarian")`
You are the librarian. Use ${Grep} to find passages before answering.` {}

// ─── a scripted model ────────────────────────────────────────────

type Turn = (
  options: LanguageModel.ProviderOptions,
) => Array<Response.StreamPartEncoded>;

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
  // `response: undefined` — the runtime schema wants the key present even
  // though the encoded interface marks it optional
  ({
    type: "finish",
    reason,
    usage,
    response: undefined,
  }) as unknown as Response.StreamPartEncoded;

/** A streamed text block: start → one delta per chunk → end. */
const text = (
  ...chunks: ReadonlyArray<string>
): Array<Response.StreamPartEncoded> =>
  [
    { type: "text-start", id: "t1" },
    ...chunks.map((delta) => ({ type: "text-delta", id: "t1", delta })),
    { type: "text-end", id: "t1" },
  ] as unknown as Array<Response.StreamPartEncoded>;

const toolCall = (
  id: string,
  name: string,
  params: unknown,
): Response.StreamPartEncoded =>
  ({
    type: "tool-call",
    id,
    name,
    params,
    providerExecuted: false,
  }) as unknown as Response.StreamPartEncoded;

/** Scripted model: turn N answers with script[N]; records every call. */
const scriptedModel = (script: ReadonlyArray<Turn>) => {
  const calls: LanguageModel.ProviderOptions[] = [];
  const layer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () =>
        Effect.die(new Error("the kernel drives streamText only")),
      streamText: (options) =>
        Stream.suspend(() => {
          calls.push(options);
          const turn = script[calls.length - 1];
          if (turn === undefined) throw new Error("script exhausted");
          return Stream.fromIterable(turn(options));
        }),
    }),
  );
  return { layer, calls };
};

// ─── harness ─────────────────────────────────────────────────────

const dispatchThrough = (
  script: ReadonlyArray<Turn>,
  grep: (input: { pattern: string }) => Effect.Effect<unknown, unknown>,
  input = "find the answer",
) => {
  const model = scriptedModel(script);
  // interpret is scoped (it acquires the ring); the scope bounds its life
  const program = Effect.scoped(
    Effect.gen(function* () {
      const kernel = yield* AI.Kernel;
      const librarian = yield* kernel.interpret(Librarian);
      return yield* librarian.dispatch(input);
    }),
  );
  return Effect.map(
    program.pipe(
      Effect.provide(
        Layer.mergeAll(
          AI.memory.pipe(Layer.provide(model.layer)),
          Layer.succeed(Grep, grep as never),
          RuntimeContext.phantom,
        ),
      ),
    ),
    (outcome) => ({ outcome: outcome as AI.Step.HaltOutcome, ...model }),
  );
};

const promptText = (options: LanguageModel.ProviderOptions): string =>
  JSON.stringify(options.prompt);

// ─── tests ───────────────────────────────────────────────────────

describe("the in-memory Kernel", () => {
  it.effect("compiles the term: system prompt + advertised toolkit", () =>
    Effect.gen(function* () {
      const { calls } = yield* dispatchThrough(
        [() => [...text("the answer is 42"), finish("stop")]],
        () => Effect.succeed("unused"),
      );
      expect(calls).toHaveLength(1);
      const options = calls[0]!;
      // rendered charter arrives as the system message, refs displayed
      expect(promptText(options)).toContain(
        "Use grep to find passages before answering.",
      );
      // the tool is advertised with its rendered description
      expect(options.tools.map((tool) => tool.name)).toEqual(["grep"]);
      expect(options.tools[0]!.description).toContain(
        "Search the corpus for {pattern}.",
      );
    }),
  );

  it.effect("executes tools itself and feeds results back to the model", () =>
    Effect.gen(function* () {
      const seen: unknown[] = [];
      const { outcome, calls } = yield* dispatchThrough(
        [
          () => [
            toolCall("c1", "grep", { pattern: "answer" }),
            finish("tool-calls"),
          ],
          () => [...text("found it in ", "ch. 42"), finish("stop")],
        ],
        (input) =>
          Effect.sync(() => {
            seen.push(input);
            return "match: chapter-42.txt";
          }),
      );
      // the kernel (not effect/ai) ran the tool, with decoded params
      expect(seen).toEqual([{ pattern: "answer" }]);
      // round 2's prompt carries the tool result, paired to the call
      expect(calls).toHaveLength(2);
      expect(promptText(calls[1]!)).toContain("match: chapter-42.txt");
      expect(outcome).toMatchObject({
        _tag: "Completed",
        text: "found it in ch. 42",
      });
    }),
  );

  it.effect("tool failures are model-visible results, never thrown", () =>
    Effect.gen(function* () {
      const { outcome, calls } = yield* dispatchThrough(
        [
          () => [
            toolCall("c1", "grep", { pattern: "x" }),
            finish("tool-calls"),
          ],
          () => [...text("the corpus is unreadable"), finish("stop")],
        ],
        () => Effect.fail("EACCES: permission denied"),
      );
      // the failure reached the model as a result part…
      expect(promptText(calls[1]!)).toContain("EACCES: permission denied");
      // …and the dispatch still completed normally (Err = never)
      expect(outcome._tag).toBe("Completed");
    }),
  );

  it.effect("one ring serves many admissions serially", () =>
    Effect.gen(function* () {
      // every turn is a single text response; the script tolerates N turns
      const answer: Turn = () => [...text("ok"), finish("stop")];
      const model = scriptedModel([answer, answer, answer]);
      const order: string[] = [];
      const outcomes = yield* Effect.scoped(
        Effect.gen(function* () {
          const kernel = yield* AI.Kernel;
          const librarian = yield* kernel.interpret(Librarian);
          // send = admission only; dispatch = admission + join. All three
          // ride the same mailbox and the same single loop, in order.
          yield* librarian.send("first");
          const a = yield* librarian.dispatch("second");
          const b = yield* librarian.dispatch("third");
          return [a, b] as AI.Step.HaltOutcome[];
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            AI.memory.pipe(Layer.provide(model.layer)),
            Layer.succeed(Grep, ((input: { pattern: string }) =>
              Effect.sync(() => order.push(input.pattern))) as never),
            RuntimeContext.phantom,
          ),
        ),
      );
      expect(outcomes.map((o) => o._tag)).toEqual(["Completed", "Completed"]);
      // three turns were served by the one loop: the sent (unjoined) item
      // ran before the dispatched ones — mailbox order, not join order
      expect(model.calls).toHaveLength(3);
      expect(promptText(model.calls[0]!)).toContain("first");
      expect(promptText(model.calls[1]!)).toContain("second");
      expect(promptText(model.calls[2]!)).toContain("third");
    }),
  );

  it.effect("KernelPolicy token ceilings halt the turn as BudgetExceeded", () =>
    Effect.gen(function* () {
      // scripted usage is 2 tokens per response (1 in + 1 out); a ceiling
      // of 1 lets round 1 run, then fires before round 2's wire call
      const model = scriptedModel([
        () => [toolCall("c1", "grep", { pattern: "x" }), finish("tool-calls")],
      ]);
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const kernel = yield* AI.Kernel;
          const librarian = yield* kernel.interpret(Librarian);
          return (yield* librarian.dispatch("dig")) as AI.Step.HaltOutcome;
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            AI.memory.pipe(Layer.provide(model.layer)),
            Layer.succeed(Grep, (() => Effect.succeed("ok")) as never),
            Layer.succeed(AI.KernelPolicy, { maxModelCalls: 24, maxTokens: 1 }),
            RuntimeContext.phantom,
          ),
        ),
      );
      expect(outcome).toMatchObject({
        _tag: "BudgetExceeded",
        limit: "tokens",
        used: 2,
        budget: 1,
      });
      // exactly one wire call was paid for — the ceiling preceded round 2
      expect(model.calls).toHaveLength(1);
    }),
  );

  it.effect("a turn writes its Trace ahead of its effects (§2.7)", () =>
    Effect.gen(function* () {
      const model = scriptedModel([
        () => [toolCall("c1", "grep", { pattern: "x" }), finish("tool-calls")],
        () => [...text("done"), finish("stop")],
      ]);
      const trace = yield* Effect.scoped(
        Effect.gen(function* () {
          const kernel = yield* AI.Kernel;
          const librarian = yield* kernel.interpret(Librarian);
          yield* librarian.dispatch("find x");
          // the ring path is the term name; replay the whole trace
          return yield* Stream.runCollect(
            kernel.trace("Librarian").pipe(Stream.take(7)),
          );
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            AI.memory.pipe(Layer.provide(model.layer)),
            Layer.succeed(Grep, (() => Effect.succeed("ok")) as never),
            RuntimeContext.phantom,
          ),
        ),
      );
      // write-ahead order: every effect's intent row precedes its terminal
      expect(trace.map((event) => event.type)).toEqual([
        "model.requested",
        "model.completed",
        "tool.requested",
        "tool.completed",
        "model.requested",
        "model.completed",
        "turn.halted",
      ]);
      // durable rows carry a contiguous per-ring cursor
      expect(trace.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      // usage rode the model terminal (budget accounting's future input)
      expect((trace[1]!.payload as any).usage).toBeDefined();
    }),
  );

  it.effect("text deltas stream to the firehose live, never to the trace", () =>
    Effect.gen(function* () {
      const model = scriptedModel([
        () => [...text("str", "eam", "ed"), finish("stop")],
      ]);
      const { deltas, trace } = yield* Effect.scoped(
        Effect.gen(function* () {
          const kernel = yield* AI.Kernel;
          const librarian = yield* kernel.interpret(Librarian);
          // subscribe to the firehose BEFORE dispatching
          const firehose = yield* Effect.forkChild(
            Stream.runCollect(
              kernel.events.pipe(
                Stream.takeUntil((event) => event.type === "turn.halted"),
              ),
            ),
          );
          yield* Effect.yieldNow;
          yield* librarian.dispatch("go");
          const events = yield* Fiber.join(firehose);
          const trace = yield* Stream.runCollect(
            kernel
              .trace("Librarian")
              .pipe(Stream.takeUntil((event) => event.type === "turn.halted")),
          );
          return {
            deltas: events.filter((event) => event.type === "model.delta"),
            trace,
          };
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            AI.memory.pipe(Layer.provide(model.layer)),
            Layer.succeed(Grep, (() => Effect.succeed("ok")) as never),
            RuntimeContext.phantom,
          ),
        ),
      );
      // the firehose saw each chunk, in order, as a LIVE (unsequenced) event
      expect(deltas.map((event) => (event.payload as any).delta)).toEqual([
        "str",
        "eam",
        "ed",
      ]);
      for (const delta of deltas) {
        expect(delta.durable).toBe(false);
        expect(delta.seq).toBeUndefined();
      }
      // the durable trace never saw them (§2.3: a delta cannot advance a cursor)
      expect(trace.every((event) => event.type !== "model.delta")).toBe(true);
    }),
  );

  it.effect("a steer while idle parks and enters the next turn's ROUND 1", () =>
    Effect.gen(function* () {
      const model = scriptedModel([() => [...text("ok"), finish("stop")]]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const kernel = yield* AI.Kernel;
          const librarian = yield* kernel.interpret(Librarian);
          // the ring is idle: this parks as a standing order
          yield* librarian.steer("always answer in French");
          yield* librarian.dispatch("find x");
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            AI.memory.pipe(Layer.provide(model.layer)),
            Layer.succeed(Grep, (() => Effect.succeed("ok")) as never),
            RuntimeContext.phantom,
          ),
        ),
      );
      // the FIRST wire call already carries the parked steer
      expect(model.calls).toHaveLength(1);
      expect(promptText(model.calls[0]!)).toContain("always answer in French");
    }),
  );

  it.effect("a mid-turn steer promotes at the next model-call boundary", () =>
    Effect.gen(function* () {
      const model = scriptedModel([
        () => [toolCall("c1", "grep", { pattern: "x" }), finish("tool-calls")],
        () => [...text("pivoting"), finish("stop")],
      ]);
      // the tool handler steers its own agent mid-turn — the cheapest way
      // to guarantee the steer lands while the turn is active
      const steerRef: {
        current?: (input: unknown) => Effect.Effect<void, never, any>;
      } = {};
      const trace = yield* Effect.scoped(
        Effect.gen(function* () {
          const kernel = yield* AI.Kernel;
          const librarian = yield* kernel.interpret(Librarian);
          steerRef.current = (input) => librarian.steer(input);
          yield* librarian.dispatch("find x");
          return yield* Stream.runCollect(
            kernel
              .trace("Librarian")
              .pipe(Stream.takeUntil((event) => event.type === "turn.halted")),
          );
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            AI.memory.pipe(Layer.provide(model.layer)),
            Layer.succeed(Grep, (() =>
              steerRef.current!("stop searching, summarize what you have").pipe(
                Effect.as("partial results"),
              )) as never),
            RuntimeContext.phantom,
          ),
        ),
      );
      // round 1 never saw the steer; round 2 (the next boundary) did
      expect(model.calls).toHaveLength(2);
      expect(promptText(model.calls[0]!)).not.toContain("stop searching");
      expect(promptText(model.calls[1]!)).toContain(
        "stop searching, summarize what you have",
      );
      // the steer is a durable admission: it rowed into the Trace
      expect(trace.some((event) => event.type === "turn.steered")).toBe(true);
    }),
  );

  it.effect("interrupt abandons the un-run batch remainder and halts", () =>
    Effect.gen(function* () {
      const model = scriptedModel([
        () => [
          toolCall("c1", "grep", { pattern: "a" }),
          toolCall("c2", "grep", { pattern: "b" }),
          finish("tool-calls"),
        ],
      ]);
      const interruptRef: {
        current?: () => Effect.Effect<void, never, any>;
      } = {};
      const ran: string[] = [];
      const { outcome, trace } = yield* Effect.scoped(
        Effect.gen(function* () {
          const kernel = yield* AI.Kernel;
          const librarian = yield* kernel.interpret(Librarian);
          interruptRef.current = () => librarian.interrupt();
          const outcome = (yield* librarian.dispatch(
            "find a and b",
          )) as AI.Step.HaltOutcome;
          const trace = yield* Stream.runCollect(
            kernel
              .trace("Librarian")
              .pipe(Stream.takeUntil((event) => event.type === "turn.halted")),
          );
          return { outcome, trace };
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            AI.memory.pipe(Layer.provide(model.layer)),
            // the FIRST tool interrupts its own agent; c2 must never run
            Layer.succeed(Grep, ((input: { pattern: string }) =>
              Effect.gen(function* () {
                ran.push(input.pattern);
                yield* interruptRef.current!();
                return "partial";
              })) as never),
            RuntimeContext.phantom,
          ),
        ),
      );
      // c1 ran and settled for real; c2 was abandoned un-run
      expect(ran).toEqual(["a"]);
      expect(outcome).toMatchObject({
        _tag: "Interrupted",
        abandoned: ["c2"],
      });
      // no second wire call was paid for
      expect(model.calls).toHaveLength(1);
      // the halt rowed into the Trace with the abandonment on record
      const halt = trace[trace.length - 1]!;
      expect(halt.type).toBe("turn.halted");
      expect(halt.payload).toMatchObject({
        outcome: "Interrupted",
        abandoned: ["c2"],
      });
    }),
  );
});

// ─── the loop runtime (§2.5) ─────────────────────────────────────

class Quest extends AI.Loop<Quest>()("Quest")`
Find the answer using ${Grep}.
${AI.until(S.Struct({ answer: S.Number }))`the numeric answer is found`}
${AI.budget({ iterations: 3 })}` {}

class Forever extends AI.Loop<Forever>()("Forever")`
Watch the horizon.
${AI.never`health = a heartbeat row every iteration`}` {}

/** Interpret + dispatch one work item through the Quest loop. */
const questThrough = (
  script: ReadonlyArray<Turn>,
  loop: {
    "~alchemy/Name": string;
  } = Quest,
) => {
  const model = scriptedModel(script);
  const program = Effect.scoped(
    Effect.gen(function* () {
      const kernel = yield* AI.Kernel;
      const quest = yield* kernel.interpret(loop as never);
      return yield* Effect.result(
        (quest as AI.LoopService<unknown, unknown, unknown>).dispatch(
          "find the answer",
        ),
      );
    }),
  );
  return Effect.map(
    program.pipe(
      Effect.provide(
        Layer.mergeAll(
          AI.memory.pipe(Layer.provide(model.layer)),
          Layer.succeed(Grep, (() => Effect.succeed("42 spotted")) as never),
          RuntimeContext.phantom,
        ),
      ),
    ),
    (result) => ({ result, ...model }),
  );
};

describe("the loop runtime", () => {
  it.effect("halt-as-tool: resolve ends the run with the typed value", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* questThrough([
        // round 1: the model resolves; round 2: it stops talking
        () => [
          toolCall("c1", "resolve", { value: JSON.stringify({ answer: 42 }) }),
          finish("tool-calls"),
        ],
        () => [...text("resolved"), finish("stop")],
      ]);
      expect(result._tag).toBe("Success");
      if (result._tag === "Success") {
        expect(result.success).toEqual({ answer: 42 });
      }
      // the charter advertises the synthetic tools alongside grep
      expect(calls[0]!.tools.map((tool) => tool.name).sort()).toEqual([
        "give_up",
        "grep",
        "resolve",
      ]);
      // the halt prose was compiled into the system prompt
      expect(promptText(calls[0]!)).toContain("Halt condition");
      expect(promptText(calls[0]!)).toContain("the numeric answer is found");
    }),
  );

  it.effect("a schema-invalid resolve bounces back for self-correction", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* questThrough([
        () => [
          toolCall("c1", "resolve", {
            value: JSON.stringify({ answer: "not a number" }),
          }),
          finish("tool-calls"),
        ],
        () => [
          toolCall("c2", "resolve", { value: JSON.stringify({ answer: 7 }) }),
          finish("tool-calls"),
        ],
        () => [...text("fixed"), finish("stop")],
      ]);
      // the failed resolve came back as a model-visible tool error
      expect(promptText(calls[1]!)).toContain("resolve rejected");
      expect(result._tag).toBe("Success");
      if (result._tag === "Success") {
        expect(result.success).toEqual({ answer: 7 });
      }
    }),
  );

  it.effect("give_up refuses the run as a typed Refused", () =>
    Effect.gen(function* () {
      const { result } = yield* questThrough([
        () => [
          toolCall("c1", "give_up", {
            reason: "the corpus has no numbers in it",
          }),
          finish("tool-calls"),
        ],
        () => [...text("gave up"), finish("stop")],
      ]);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(AI.Refused);
        expect((result.failure as AI.Refused).reason).toContain("no numbers");
      }
    }),
  );

  it.effect("the iteration budget exceeds as a typed BudgetExceeded", () =>
    Effect.gen(function* () {
      // every turn completes without resolving; the boundary nags twice,
      // then the charter's iterations: 3 ceiling fires
      const evasive: Turn = () => [...text("still looking"), finish("stop")];
      const { result, calls } = yield* questThrough([
        evasive,
        evasive,
        evasive,
      ]);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(AI.BudgetExceeded);
        const budget = result.failure as AI.BudgetExceeded;
        expect(budget.limit).toBe("iterations");
        expect(budget.used).toBe(3);
        expect(budget.budget).toBe(3);
      }
      // iteration 2's prompt carries the boundary nag
      expect(calls).toHaveLength(3);
      expect(promptText(calls[1]!)).toContain("The run has not ended");
      // the fold carried the transcript: iteration 3 still sees round 1
      expect(promptText(calls[2]!)).toContain("still looking");
    }),
  );

  it.effect("perpetual charters are rejected until the trigger runtime", () =>
    Effect.gen(function* () {
      const model = scriptedModel([]);
      const result = yield* Effect.result(
        Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            return yield* kernel.interpret(Forever as never);
          }),
        ).pipe(Effect.provide(AI.memory.pipe(Layer.provide(model.layer)))),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(AI.KernelError);
        expect((result.failure as AI.KernelError).term).toBe("Forever");
      }
    }),
  );
});
