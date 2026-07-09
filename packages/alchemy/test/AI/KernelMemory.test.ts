/**
 * End-to-end tests for the in-memory reference Kernel (design §2.6):
 * an Agent term is interpreted against a *scripted* LanguageModel — no
 * network — proving the full pipeline: template → system prompt, tool
 * refs → advertised toolkit, kernel-owned tool execution
 * (disableToolCallResolution), model-visible tool failures, and the
 * kernel-default halt.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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

// ─── delegation (§1.5 Stage A) ───────────────────────────────────

class Sage extends AI.Agent<Sage>()("Sage")`
You are the sage. Answer questions truthfully and briefly.` {}

class Chief extends AI.Agent<Chief>()("Chief")`
You are the chief. For any question, delegate to ${Sage} and repeat
its answer verbatim.` {}

describe("delegation", () => {
  it.effect(
    "an interpolated Agent becomes a tool whose handler dispatches",
    () =>
      Effect.gen(function* () {
        const model = scriptedModel([
          // 1: Chief's ring — sees the Sage delegation tool and uses it
          () => [
            toolCall("d1", "Sage", { task: "what is the answer?" }),
            finish("tool-calls"),
          ],
          // 2: Sage's ring — its OWN charter, serving the delegated task
          () => [...text("the answer is 42"), finish("stop")],
          // 3: Chief's round 2 — the distilled result came back
          () => [...text("the sage says: the answer is 42"), finish("stop")],
        ]);
        const kernelLayer = AI.memory.pipe(Layer.provide(model.layer));
        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const chief = yield* kernel.interpret(Chief);
            return (yield* chief.dispatch(
              "what is the answer?",
            )) as AI.Step.HaltOutcome;
          }),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              kernelLayer,
              // the delegate's ring comes from its own kernel-default Layer
              AI.layer(Sage).pipe(
                Layer.provide([kernelLayer, RuntimeContext.phantom]),
              ),
              RuntimeContext.phantom,
            ),
          ),
        );

        expect(outcome).toMatchObject({
          _tag: "Completed",
          text: "the sage says: the answer is 42",
        });
        expect(model.calls).toHaveLength(3);
        // call 1: the Chief was offered Sage as a tool, charter included
        const advertised = model.calls[0]!.tools.find(
          (tool) => tool.name === "Sage",
        );
        expect(advertised).toBeDefined();
        expect(advertised!.description).toContain("You are the sage");
        // call 2 ran on the SAGE's ring: its own charter is the system
        // prompt and the Chief's transcript is nowhere in sight
        expect(promptText(model.calls[1]!)).toContain("You are the sage");
        expect(promptText(model.calls[1]!)).not.toContain("You are the chief");
        expect(promptText(model.calls[1]!)).toContain("what is the answer?");
        // call 3: the Chief got the DISTILLED result, not Sage's transcript
        expect(promptText(model.calls[2]!)).toContain("the answer is 42");
      }),
  );
});

describe("spawn-and-continue (§2.8)", () => {
  it.effect("background delegation returns a key; the result steers back", () =>
    Effect.gen(function* () {
      // two rings share one wire: route by system prompt so the test is
      // deterministic regardless of fiber interleaving
      let chiefCalls = 0;
      const calls: LanguageModel.ProviderOptions[] = [];
      const model = Layer.effect(
        LanguageModel.LanguageModel,
        LanguageModel.make({
          generateText: () => Effect.die(new Error("streamText only")),
          streamText: (options) =>
            Stream.suspend(() => {
              calls.push(options);
              if (promptText(options).includes("You are the sage")) {
                return Stream.fromIterable([
                  ...text("the answer is 42"),
                  finish("stop"),
                ]);
              }
              chiefCalls++;
              return Stream.fromIterable(
                chiefCalls === 1
                  ? [
                      toolCall("d1", "Sage", {
                        task: "find the answer",
                        background: true,
                      }),
                      finish("tool-calls"),
                    ]
                  : chiefCalls === 2
                    ? [...text("spawned; standing by"), finish("stop")]
                    : [
                        ...text("the background run reported 42"),
                        finish("stop"),
                      ],
              );
            }),
        }),
      );

      const kernelLayer = AI.memory.pipe(Layer.provide(model));
      const { first, second } = yield* Effect.scoped(
        Effect.gen(function* () {
          const kernel = yield* AI.Kernel;
          const chief = yield* kernel.interpret(Chief);
          // turn 1: spawn in background, then end the turn
          const first = (yield* chief.dispatch(
            "find the answer, in the background",
          )) as AI.Step.HaltOutcome;
          // wait until the SAGE's run has halted (rows are truth)
          yield* Stream.runCollect(
            kernel
              .trace("Sage")
              .pipe(Stream.takeUntil((event) => event.type === "turn.halted")),
          );
          // the completion steer parked (chief was idle); turn 2 sees it
          const second = (yield* chief.dispatch(
            "what happened?",
          )) as AI.Step.HaltOutcome;
          return { first, second };
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            kernelLayer,
            AI.layer(Sage).pipe(
              Layer.provide([kernelLayer, RuntimeContext.phantom]),
            ),
            RuntimeContext.phantom,
          ),
        ),
      );

      expect(first._tag).toBe("Completed");
      expect(second).toMatchObject({
        _tag: "Completed",
        text: "the background run reported 42",
      });
      const chiefPrompts = calls.filter(
        (options) => !promptText(options).includes("You are the sage"),
      );
      // chief round 1: the async surface was advertised with the delegate
      expect(chiefPrompts[0]!.tools.map((tool) => tool.name).sort()).toEqual([
        "Sage",
        "check_runs",
        "wait_run",
      ]);
      // chief round 2 (same turn): the spawn returned a RUN KEY, not a result
      expect(promptText(chiefPrompts[1]!)).toContain(
        "spawned background run Sage#bg0",
      );
      expect(promptText(chiefPrompts[1]!)).not.toContain("the answer is 42");
      // chief turn 2 round 1: the parked completion steer was promoted
      expect(promptText(chiefPrompts[2]!)).toContain(
        "Background run Sage#bg0 completed: the answer is 42",
      );
    }),
  );
});

// ─── the Ask protocol (§2.4) ─────────────────────────────────────

const action = AI.Parameter("action", S.String)`the action needing approval`;

class Approve extends AI.Tool<Approve>()("approve")`
Request human approval for ${action}. Blocks until a decision arrives.` {}

class Deployer extends AI.Agent<Deployer>()("Deployer")`
You are the deployer. Before ANY deploy, request approval with
${Approve}; obey the verdict.` {}

/** A human-class tool: ordinary user code over the kernel's Ask service. */
const ApproveViaAsk = Layer.succeed(Approve, ((input: { action: string }) =>
  Effect.gen(function* () {
    const ask = yield* AI.Ask;
    const answer = yield* ask({ kind: "approval", text: input.action });
    if (answer.verdict !== "approved") {
      return yield* Effect.fail(`denied: ${answer.text ?? "no reason given"}`);
    }
    return `approved${answer.amendment !== undefined ? ` (${answer.amendment})` : ""}`;
  })) as never);

describe("the Ask protocol (§2.4)", () => {
  const askScript = (finalText: string): ReadonlyArray<Turn> => [
    () => [
      toolCall("a1", "approve", { action: "deploy to prod" }),
      finish("tool-calls"),
    ],
    () => [...text(finalText), finish("stop")],
  ];

  const deployThrough = (script: ReadonlyArray<Turn>, answer: AI.AskAnswer) => {
    const model = scriptedModel(script);
    const program = Effect.scoped(
      Effect.gen(function* () {
        const kernel = yield* AI.Kernel;
        const hub = yield* AI.AskHub;
        const deployer = yield* kernel.interpret(Deployer);
        const running = yield* Effect.forkChild(deployer.dispatch("ship it"));
        // the world side: wait for the park, inspect it, answer it.
        // (clock-free yield poll — it.effect's TestClock freezes
        // Schedule.spaced, the same trap as the live-cascade test)
        const pending = yield* Effect.gen(function* () {
          for (let spins = 0; spins < 10_000; spins++) {
            const asks = yield* hub.pending;
            if (asks.length > 0) return asks;
            yield* Effect.yieldNow;
          }
          return yield* Effect.die(new Error("no ask ever parked"));
        });
        yield* hub.answer(pending[0]!.id, answer);
        const outcome = (yield* Fiber.join(running)) as AI.Step.HaltOutcome;
        const trace = yield* Stream.runCollect(
          kernel
            .trace("Deployer")
            .pipe(Stream.takeUntil((event) => event.type === "turn.halted")),
        );
        return { pending, outcome, trace, calls: model.calls };
      }),
    );
    return program.pipe(
      Effect.provide(
        Layer.mergeAll(
          AI.memory.pipe(Layer.provide([model.layer, AI.AskHubMemory])),
          AI.AskHubMemory,
          ApproveViaAsk,
          RuntimeContext.phantom,
        ),
      ),
    );
  };

  it.effect("a tool parks on ask; the answer resumes the turn (approved)", () =>
    Effect.gen(function* () {
      const { pending, outcome, trace, calls } = yield* deployThrough(
        askScript("deployed"),
        {
          verdict: "approved",
          amendment: "approved for this session",
        },
      );
      // the park was inspectable from the world side
      expect(pending[0]!.ring).toBe("Deployer");
      expect(pending[0]!.payload).toEqual({
        kind: "approval",
        text: "deploy to prod",
      });
      expect(outcome).toMatchObject({ _tag: "Completed", text: "deployed" });
      // the verdict AND the amendment reached the model
      expect(promptText(calls[1]!)).toContain(
        "approved (approved for this session)",
      );
      // the park rowed into the Trace write-ahead: requested before answered
      const types = trace.map((event) => event.type);
      expect(types.indexOf("ask.requested")).toBeGreaterThan(-1);
      expect(types.indexOf("ask.requested")).toBeLessThan(
        types.indexOf("ask.answered"),
      );
    }),
  );

  it.effect("a denial is a model-visible result, never a thrown error", () =>
    Effect.gen(function* () {
      const { outcome, calls } = yield* deployThrough(
        askScript("standing down"),
        { verdict: "denied", text: "not during the freeze" },
      );
      // the turn survived the denial and reacted to it
      expect(outcome).toMatchObject({
        _tag: "Completed",
        text: "standing down",
      });
      expect(promptText(calls[1]!)).toContain("denied: not during the freeze");
    }),
  );

  it.effect("wait_run parks on a background run and returns its result", () =>
    Effect.gen(function* () {
      // the chief spawns in background, then immediately joins via
      // wait_run — same turn, no steer needed
      const model = scriptedModel([]);
      const routed = Layer.effect(
        LanguageModel.LanguageModel,
        LanguageModel.make({
          generateText: () => Effect.die(new Error("streamText only")),
          streamText: (options) =>
            Stream.suspend(() => {
              model.calls.push(options);
              const prompt = JSON.stringify(options.prompt);
              if (prompt.includes("You are the sage")) {
                return Stream.fromIterable([
                  ...text("wisdom: 42"),
                  finish("stop"),
                ]);
              }
              const chiefRound = model.calls.filter(
                (c) => !JSON.stringify(c.prompt).includes("You are the sage"),
              ).length;
              return Stream.fromIterable(
                chiefRound === 1
                  ? [
                      toolCall("d1", "Sage", {
                        task: "wisdom?",
                        background: true,
                      }),
                      finish("tool-calls"),
                    ]
                  : chiefRound === 2
                    ? [
                        toolCall("w1", "wait_run", { key: "Sage#bg0" }),
                        finish("tool-calls"),
                      ]
                    : [...text("joined: wisdom: 42"), finish("stop")],
              );
            }),
        }),
      );
      const kernelLayer = AI.memory.pipe(Layer.provide(routed));
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const kernel = yield* AI.Kernel;
          const chief = yield* kernel.interpret(Chief);
          return (yield* chief.dispatch(
            "spawn then join",
          )) as AI.Step.HaltOutcome;
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            kernelLayer,
            AI.layer(Sage).pipe(
              Layer.provide([kernelLayer, RuntimeContext.phantom]),
            ),
            RuntimeContext.phantom,
          ),
        ),
      );
      expect(outcome).toMatchObject({
        _tag: "Completed",
        text: "joined: wisdom: 42",
      });
      // the join round saw the settled result
      const chiefPrompts = model.calls.filter(
        (c) => !JSON.stringify(c.prompt).includes("You are the sage"),
      );
      expect(promptText(chiefPrompts[2]!)).toContain("wisdom: 42");
    }),
  );
});

// ─── interrupt cascade (§2.8b) ───────────────────────────────────

class Digger extends AI.Agent<Digger>()("Digger")`
You are the digger. Dig with ${Grep} until told otherwise.` {}

class Boss extends AI.Agent<Boss>()("Boss")`
You are the boss. Delegate all digging to ${Digger}.` {}

describe("interrupt cascade (§2.8b)", () => {
  it.effect("interrupting the parent cancels its in-flight delegate", () =>
    Effect.gen(function* () {
      // route by charter: the boss delegates, the digger digs
      const model = Layer.effect(
        LanguageModel.LanguageModel,
        LanguageModel.make({
          generateText: () => Effect.die(new Error("streamText only")),
          streamText: (options) =>
            Stream.suspend(() =>
              Stream.fromIterable(
                JSON.stringify(options.prompt).includes("You are the digger")
                  ? [
                      toolCall("g1", "grep", { pattern: "gold" }),
                      finish("tool-calls"),
                    ]
                  : [
                      toolCall("d1", "Digger", { task: "dig for gold" }),
                      finish("tool-calls"),
                    ],
              ),
            ),
        }),
      );

      // the digger's grep BLOCKS until cancelled — the cascade must
      // fiber-interrupt it through two rings
      const started = yield* Deferred.make<void>();
      let grepInterrupted = false;
      const BlockingGrep = Layer.succeed(Grep, ((_input: unknown) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, void 0);
          yield* Effect.never;
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              grepInterrupted = true;
            }),
          ),
        )) as never);

      const kernelLayer = AI.memory.pipe(Layer.provide(model));
      const { outcome, diggerTrace } = yield* Effect.scoped(
        Effect.gen(function* () {
          const kernel = yield* AI.Kernel;
          const boss = yield* kernel.interpret(Boss);
          const running = yield* Effect.forkChild(boss.dispatch("dig!"));
          // wait until the delegate is genuinely mid-tool
          yield* Deferred.await(started);
          yield* boss.interrupt();
          const outcome = (yield* Fiber.join(running)) as AI.Step.HaltOutcome;
          const diggerTrace = yield* Stream.runCollect(
            kernel
              .trace("Digger")
              .pipe(Stream.takeUntil((event) => event.type === "turn.halted")),
          );
          return { outcome, diggerTrace };
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            kernelLayer,
            AI.layer(Digger).pipe(
              Layer.provide([
                kernelLayer,
                BlockingGrep,
                RuntimeContext.phantom,
              ]),
            ),
            RuntimeContext.phantom,
          ),
        ),
      );

      // the parent settled as Interrupted (not deadlocked on the child)
      expect(outcome._tag).toBe("Interrupted");
      // the cascade reached the child: its turn halted as Interrupted…
      const halt = diggerTrace[diggerTrace.length - 1]!;
      expect(halt.type).toBe("turn.halted");
      expect((halt.payload as any).outcome).toBe("Interrupted");
      // …and the blocking tool execution was genuinely fiber-interrupted
      expect(grepInterrupted).toBe(true);
    }),
  );

  it.effect(
    "interrupting the parent tombstones queued (never-run) admissions",
    () =>
      Effect.gen(function* () {
        // the boss spawns task A in the BACKGROUND (occupies the digger's
        // serial ring) then delegates task B synchronously (queued behind
        // A). Interrupting the boss must cancel BOTH: A mid-tool, B before
        // it ever runs a turn.
        let diggerTurns = 0;
        const model = Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: () => Effect.die(new Error("streamText only")),
            streamText: (options) =>
              Stream.suspend(() => {
                if (
                  JSON.stringify(options.prompt).includes("You are the digger")
                ) {
                  diggerTurns++;
                  return Stream.fromIterable([
                    toolCall("g1", "grep", { pattern: "gold" }),
                    finish("tool-calls"),
                  ]);
                }
                return Stream.fromIterable([
                  toolCall("d1", "Digger", {
                    task: "task A",
                    background: true,
                  }),
                  toolCall("d2", "Digger", { task: "task B" }),
                  finish("tool-calls"),
                ]);
              }),
          }),
        );

        const started = yield* Deferred.make<void>();
        const BlockingGrep = Layer.succeed(Grep, ((_input: unknown) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, void 0);
            yield* Effect.never;
          })) as never);

        const kernelLayer = AI.memory.pipe(Layer.provide(model));
        const { outcome, diggerHalts } = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const boss = yield* kernel.interpret(Boss);
            const running = yield* Effect.forkChild(boss.dispatch("dig twice"));
            yield* Deferred.await(started); // A is mid-tool; B is queued
            yield* boss.interrupt();
            const outcome = (yield* Fiber.join(running)) as AI.Step.HaltOutcome;
            // rows are truth: wait for A's halt, then let the ring drain
            const diggerHalts = yield* Stream.runCollect(
              kernel
                .trace("Digger")
                .pipe(
                  Stream.takeUntil((event) => event.type === "turn.halted"),
                ),
            );
            yield* Effect.yieldNow;
            return { outcome, diggerHalts };
          }),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              kernelLayer,
              AI.layer(Digger).pipe(
                Layer.provide([
                  kernelLayer,
                  BlockingGrep,
                  RuntimeContext.phantom,
                ]),
              ),
              RuntimeContext.phantom,
            ),
          ),
        );

        expect(outcome._tag).toBe("Interrupted");
        // task A's turn was interrupted; task B NEVER became a turn — the
        // digger's model was consulted exactly once
        expect(
          (diggerHalts[diggerHalts.length - 1]!.payload as any).outcome,
        ).toBe("Interrupted");
        expect(diggerTurns).toBe(1);
      }),
  );
});

// ─── the loop runtime (§2.5) ─────────────────────────────────────

class Quest extends AI.Loop<Quest>()("Quest")`
Find the answer using ${Grep}.
${AI.until(S.Struct({ answer: S.Number }))`the numeric answer is found`}
${AI.budget({ iterations: 3 })}` {}

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

  it.effect(
    "AI.check: the verifier rejects a claim, then ratifies the fix",
    () =>
      Effect.gen(function* () {
        class Judge extends AI.Agent<Judge>()("Judge")`
You are the judge. Grade strictly; never trust the worker.` {}
        class CheckedQuest extends AI.Loop<CheckedQuest>()("CheckedQuest")`
Find the answer using ${Grep}.
${AI.until(S.Struct({ answer: S.Number }))`the numeric answer is found`}
${AI.check(Judge)`the answer must equal 42 exactly`}
${AI.budget({ iterations: 4 })}` {}

        let judgeCalls = 0;
        let questRounds = 0;
        const calls: LanguageModel.ProviderOptions[] = [];
        const model = Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: () => Effect.die(new Error("streamText only")),
            streamText: (options) =>
              Stream.suspend(() => {
                calls.push(options);
                if (
                  JSON.stringify(options.prompt).includes("You are the judge")
                ) {
                  judgeCalls++;
                  return Stream.fromIterable([
                    ...text(
                      judgeCalls === 1
                        ? '{"verdict":"off-goal","reason":"41 is not 42, recount"}'
                        : '{"verdict":"goal-met"}',
                    ),
                    finish("stop"),
                  ]);
                }
                questRounds++;
                return Stream.fromIterable(
                  questRounds === 1
                    ? [
                        toolCall("c1", "resolve", {
                          value: JSON.stringify({ answer: 41 }),
                        }),
                        finish("tool-calls"),
                      ]
                    : questRounds === 2
                      ? [...text("claimed 41"), finish("stop")]
                      : questRounds === 3
                        ? [
                            toolCall("c2", "resolve", {
                              value: JSON.stringify({ answer: 42 }),
                            }),
                            finish("tool-calls"),
                          ]
                        : [...text("claimed 42"), finish("stop")],
                );
              }),
          }),
        );

        const kernelLayer = AI.memory.pipe(Layer.provide(model));
        const { value, trace } = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const quest = yield* kernel.interpret(CheckedQuest);
            const value = yield* (
              quest as AI.LoopService<unknown, unknown, unknown>
            ).dispatch("find it");
            const trace = yield* Stream.runCollect(
              kernel
                .trace("CheckedQuest")
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
              AI.layer(Judge).pipe(
                Layer.provide([kernelLayer, RuntimeContext.phantom]),
              ),
              Layer.succeed(Grep, (() =>
                Effect.succeed("42 spotted")) as never),
              RuntimeContext.phantom,
            ),
          ),
        );

        // the fixed claim was ratified
        expect(value).toEqual({ answer: 42 });
        expect(judgeCalls).toBe(2);
        // the judge saw the halt prose, the claim, and the ring instructions
        const judgePrompt = JSON.stringify(
          calls.find((c) =>
            JSON.stringify(c.prompt).includes("You are the judge"),
          )!.prompt,
        );
        expect(judgePrompt).toContain("the numeric answer is found");
        expect(judgePrompt).toContain('{\\"answer\\":41}');
        expect(judgePrompt).toContain("must equal 42 exactly");
        // the rejection became the next iteration's first input
        const questPrompts = calls.filter(
          (c) => !JSON.stringify(c.prompt).includes("You are the judge"),
        );
        expect(promptText(questPrompts[2]!)).toContain(
          "The verifier rejected your resolution: 41 is not 42",
        );
        // the grading rowed into the Trace: requested before verdict
        const types = trace.map((event) => event.type);
        expect(types.indexOf("check.requested")).toBeGreaterThan(-1);
        expect(types.indexOf("check.requested")).toBeLessThan(
          types.indexOf("check.verdict"),
        );
      }),
  );

  it.effect("a MACHINE check verifies claims with zero model traffic", () =>
    Effect.gen(function* () {
      // the deterministic oracle: no judge ring, no tokens, un-gameable
      const graded: unknown[] = [];
      class MachineQuest extends AI.Loop<MachineQuest>()("MachineQuest")`
Find the answer with ${Grep}.
${AI.until(S.Struct({ answer: S.Number }))`the answer is found`}
${AI.check(
  (input): Effect.Effect<AI.CheckVerdict> =>
    Effect.sync(() => {
      graded.push(input.claim);
      return (input.claim as { answer: number }).answer === 42
        ? { verdict: "goal-met" }
        : { verdict: "off-goal", reason: "the answer must be exactly 42" };
    }),
)}
${AI.budget({ iterations: 4 })}` {}

      let rounds = 0;
      const calls: LanguageModel.ProviderOptions[] = [];
      const model = Layer.effect(
        LanguageModel.LanguageModel,
        LanguageModel.make({
          generateText: () => Effect.die(new Error("streamText only")),
          streamText: (options) =>
            Stream.suspend(() => {
              calls.push(options);
              rounds++;
              return Stream.fromIterable(
                rounds === 1
                  ? [
                      toolCall("c1", "resolve", {
                        value: JSON.stringify({ answer: 41 }),
                      }),
                      finish("tool-calls"),
                    ]
                  : rounds === 2
                    ? [...text("claimed 41"), finish("stop")]
                    : rounds === 3
                      ? [
                          toolCall("c2", "resolve", {
                            value: JSON.stringify({ answer: 42 }),
                          }),
                          finish("tool-calls"),
                        ]
                      : [...text("claimed 42"), finish("stop")],
              );
            }),
        }),
      );

      const value = yield* Effect.scoped(
        Effect.gen(function* () {
          const kernel = yield* AI.Kernel;
          const quest = yield* kernel.interpret(MachineQuest);
          return yield* (
            quest as AI.LoopService<unknown, unknown, unknown>
          ).dispatch("find it");
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            AI.memory.pipe(Layer.provide(model)),
            Layer.succeed(Grep, (() => Effect.succeed("ok")) as never),
            RuntimeContext.phantom,
          ),
        ),
      );

      // both claims were graded by the oracle; only the correct one passed
      expect(graded).toEqual([{ answer: 41 }, { answer: 42 }]);
      expect(value).toEqual({ answer: 42 });
      // every model call belonged to the WORKER — no judge traffic at all
      expect(calls).toHaveLength(4);
      // the machine rejection steered iteration 2, same as a fuzzy judge's
      expect(promptText(calls[2]!)).toContain("must be exactly 42");
    }),
  );

  it.effect(
    "an ungradable verdict is check-failed — never a silent re-loop",
    () =>
      Effect.gen(function* () {
        class Rubber extends AI.Agent<Rubber>()("Rubber")`
You are the rubber stamp.` {}
        class StampedQuest extends AI.Loop<StampedQuest>()("StampedQuest")`
Find the answer with ${Grep}.
${AI.until(S.Struct({ answer: S.Number }))`the answer is found`}
${AI.check(Rubber)}
${AI.budget({ iterations: 3 })}` {}

        let questRounds = 0;
        const model = Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: () => Effect.die(new Error("streamText only")),
            streamText: (options) =>
              Stream.suspend(() => {
                if (JSON.stringify(options.prompt).includes("rubber stamp")) {
                  // no JSON: ungradable
                  return Stream.fromIterable([
                    ...text("LGTM!"),
                    finish("stop"),
                  ]);
                }
                questRounds++;
                return Stream.fromIterable(
                  questRounds === 1
                    ? [
                        toolCall("c1", "resolve", {
                          value: JSON.stringify({ answer: 7 }),
                        }),
                        finish("tool-calls"),
                      ]
                    : [...text("claimed"), finish("stop")],
                );
              }),
          }),
        );
        const kernelLayer = AI.memory.pipe(Layer.provide(model));
        const exit = yield* Effect.exit(
          Effect.scoped(
            Effect.gen(function* () {
              const kernel = yield* AI.Kernel;
              const quest = yield* kernel.interpret(StampedQuest);
              return yield* (
                quest as AI.LoopService<unknown, unknown, unknown>
              ).dispatch("find it");
            }),
          ).pipe(
            Effect.provide(
              Layer.mergeAll(
                kernelLayer,
                AI.layer(Rubber).pipe(
                  Layer.provide([kernelLayer, RuntimeContext.phantom]),
                ),
                Layer.succeed(Grep, (() => Effect.succeed("ok")) as never),
                RuntimeContext.phantom,
              ),
            ),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("check-failed");
        }
      }),
  );

  it.effect(
    "undeclared perpetuity (no halt at all) is linted at interpret",
    () =>
      Effect.gen(function* () {
        class NoHalt extends AI.Loop<NoHalt>()("NoHalt")`
Just keep working with ${Grep}.` {}
        const model = scriptedModel([]);
        const result = yield* Effect.result(
          Effect.scoped(
            Effect.gen(function* () {
              const kernel = yield* AI.Kernel;
              return yield* kernel.interpret(NoHalt as never);
            }),
          ).pipe(
            Effect.provide(
              Layer.mergeAll(
                AI.memory.pipe(Layer.provide(model.layer)),
                Layer.succeed(Grep, (() => Effect.succeed("ok")) as never),
                RuntimeContext.phantom,
              ),
            ),
          ),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure).toBeInstanceOf(AI.KernelError);
          expect((result.failure as AI.KernelError).message).toContain(
            "undeclared perpetuity",
          );
        }
      }),
  );
});

// ─── the trigger runtime (§2.5) ──────────────────────────────────

const Ping = AI.EventSource(
  "test.ping",
  S.Struct({ n: S.Number, note: S.String }),
);

const observation = AI.Parameter(
  "observation",
  S.String,
)`what you observed in the work item`;

class Recorder extends AI.Tool<Recorder>()("record")`
Record ${observation} in the log. Call this for every work item.` {}

class Watcher extends AI.Loop<Watcher>()("Watcher")`
You watch for pings. For every work item, call ${Recorder} with the
ping's note, then stop.
${AI.on(Ping)}
${AI.never`health = one record row per ping`}` {}

describe("the trigger runtime (§2.5)", () => {
  it.effect("run() serves a kernel-internal EventSource as admissions", () =>
    Effect.gen(function* () {
      // every Watcher turn: record the input, then quiesce
      let rounds = 0;
      const model = Layer.effect(
        LanguageModel.LanguageModel,
        LanguageModel.make({
          generateText: () => Effect.die(new Error("streamText only")),
          streamText: () =>
            Stream.suspend(() =>
              Stream.fromIterable(
                ++rounds % 2 === 1
                  ? [
                      toolCall(`c${rounds}`, "record", {
                        observation: `saw ping ${rounds}`,
                      }),
                      finish("tool-calls"),
                    ]
                  : [...text("recorded"), finish("stop")],
              ),
            ),
        }),
      );
      const recorded: string[] = [];
      const RecorderLive = Layer.succeed(Recorder, ((input: {
        observation: string;
      }) =>
        Effect.sync(() => {
          recorded.push(input.observation);
          return "logged";
        })) as never);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const kernel = yield* AI.Kernel;
          const bus = yield* AI.EventBus;
          const watcher = yield* kernel.interpret(Watcher);
          // serve the ring's triggers in the background
          yield* Effect.forkChild(watcher.run());
          yield* Effect.yieldNow;
          // the world pings twice
          yield* bus.publish(Ping, { n: 1, note: "first" });
          yield* bus.publish(Ping, { n: 2, note: "second" });
          // rows are truth: wait for two halted turns (clock-free poll)
          for (let spins = 0; spins < 50_000; spins++) {
            if (recorded.length >= 2) return;
            yield* Effect.yieldNow;
          }
          return yield* Effect.die(new Error("pings never served"));
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            AI.memory.pipe(Layer.provide([model, AI.EventBusMemory])),
            AI.EventBusMemory,
            RecorderLive,
            RuntimeContext.phantom,
          ),
        ),
      );

      // both events became runs, in order, on the one serial ring
      expect(recorded).toEqual(["saw ping 1", "saw ping 3"]);
    }),
  );
});
