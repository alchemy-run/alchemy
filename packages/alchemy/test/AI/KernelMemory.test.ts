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
) => Array<Response.PartEncoded>;

const usage = {
  inputTokens: {
    uncached: undefined,
    total: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const finish = (reason: string): Response.PartEncoded =>
  // `response: undefined` — the runtime schema wants the key present even
  // though the encoded interface marks it optional
  ({
    type: "finish",
    reason,
    usage,
    response: undefined,
  }) as unknown as Response.PartEncoded;

const text = (content: string): Response.PartEncoded =>
  ({ type: "text", text: content }) as unknown as Response.PartEncoded;

const toolCall = (
  id: string,
  name: string,
  params: unknown,
): Response.PartEncoded =>
  ({
    type: "tool-call",
    id,
    name,
    params,
    providerExecuted: false,
  }) as unknown as Response.PartEncoded;

/** Scripted model: turn N answers with script[N]; records every call. */
const scriptedModel = (script: ReadonlyArray<Turn>) => {
  const calls: LanguageModel.ProviderOptions[] = [];
  const layer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: (options) =>
        Effect.sync(() => {
          calls.push(options);
          const turn = script[calls.length - 1];
          if (turn === undefined) throw new Error("script exhausted");
          return turn(options);
        }),
      streamText: () => Stream.die(new Error("streaming is not scripted")),
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
        [() => [text("the answer is 42"), finish("stop")]],
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
          () => [text("found it in ch. 42"), finish("stop")],
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
          () => [text("the corpus is unreadable"), finish("stop")],
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
      const answer: Turn = () => [text("ok"), finish("stop")];
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

  it.effect("a turn writes its Trace ahead of its effects (§2.7)", () =>
    Effect.gen(function* () {
      const model = scriptedModel([
        () => [toolCall("c1", "grep", { pattern: "x" }), finish("tool-calls")],
        () => [text("done"), finish("stop")],
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

  it.effect(
    "loop terms are honestly rejected until the loop runtime lands",
    () =>
      Effect.gen(function* () {
        const model = scriptedModel([]);
        const result = yield* Effect.result(
          Effect.scoped(
            Effect.gen(function* () {
              const kernel = yield* AI.Kernel;
              // a non-agent term: the kernel must fail typed, not die
              return yield* kernel.interpret({
                "~alchemy/Kind": "Loop",
                "~alchemy/Name": "NotYet",
              } as never);
            }),
          ).pipe(Effect.provide(AI.memory.pipe(Layer.provide(model.layer)))),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure).toBeInstanceOf(AI.KernelError);
          expect((result.failure as AI.KernelError).term).toBe("NotYet");
        }
      }),
  );
});
