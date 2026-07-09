/**
 * The KernelEvent → UIMessageChunk fold, tested against REAL kernel
 * emissions (a scripted turn's firehose and trace) rather than
 * hand-crafted events — so the adapter and the kernel's event shapes
 * cannot drift apart.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as Stream from "effect/Stream";
import * as AiErrorModule from "effect/unstable/ai/AiError";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as Response from "effect/unstable/ai/Response";
import { sessionEvents, toChunks } from "@/AI/Api/Chunks.ts";
import * as AI from "@/AI/index.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";

void AiErrorModule;

// ─── fixtures (same shapes as KernelMemory.test) ─────────────────

const pattern = AI.Parameter("pattern", S.String)`the regex to search for`;
class Grep extends AI.Tool<Grep>()("grep")`
Search the corpus for ${pattern}.` {}
class Librarian extends AI.Agent<Librarian>()("Librarian")`
You are the librarian. Use ${Grep} to find passages before answering.` {}

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
  ({
    type: "finish",
    reason,
    usage,
    response: undefined,
  }) as unknown as Response.StreamPartEncoded;
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

type Turn = () => Array<Response.StreamPartEncoded>;
const scriptedModel = (script: ReadonlyArray<Turn>) => {
  let calls = 0;
  return Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.die(new Error("streamText only")),
      streamText: () =>
        Stream.suspend(() => {
          const turn = script[calls++];
          if (turn === undefined) throw new Error("script exhausted");
          return Stream.fromIterable(turn());
        }),
    }),
  );
};

/** Run one tool-using scripted turn; return firehose events + trace. */
const runTurn = Effect.gen(function* () {
  const kernel = yield* AI.Kernel;
  const librarian = yield* kernel.interpret(Librarian);
  const firehose = yield* Effect.forkChild(
    Stream.runCollect(
      kernel.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.halted"),
      ),
    ),
  );
  yield* Effect.yieldNow;
  yield* librarian.dispatch("find the answer");
  const live = yield* Fiber.join(firehose);
  const trace = yield* Stream.runCollect(
    kernel
      .trace("Librarian")
      .pipe(Stream.takeUntil((event) => event.type === "turn.halted")),
  );
  return { live, trace };
});

const layers = (script: ReadonlyArray<Turn>) =>
  Layer.mergeAll(
    AI.memory.pipe(Layer.provide(scriptedModel(script))),
    Layer.succeed(Grep, (() => Effect.succeed("found: ch. 42")) as never),
    RuntimeContext.phantom,
  );

describe("KernelEvent → UIMessageChunk", () => {
  const script: ReadonlyArray<Turn> = [
    () => [toolCall("c1", "grep", { pattern: "answer" }), finish("tool-calls")],
    () => [...text("it is ", "42"), finish("stop")],
  ];

  it.effect("the LIVE fold streams text deltas and tool lifecycle", () =>
    Effect.gen(function* () {
      const { live } = yield* runTurn.pipe(
        Effect.scoped,
        Effect.provide(layers(script)),
      );
      const session = live.find((e) => e.session !== undefined)!.session!;
      const chunks = yield* Stream.runCollect(
        toChunks(sessionEvents(Stream.fromIterable(live), session)),
      );
      expect(chunks.map((chunk) => chunk.type)).toEqual([
        "start",
        "start-step", // round 1
        "tool-input-start",
        "tool-input-available",
        "tool-output-available",
        "finish-step",
        "start-step", // round 2
        "text-start",
        "text-delta", // "it is "
        "text-delta", // "42"
        "text-end",
        "finish-step",
        "finish",
      ]);
      // the enriched payloads rode through
      const input = chunks.find((c) => c.type === "tool-input-available")!;
      expect((input as { input: unknown }).input).toEqual({
        pattern: "answer",
      });
      const output = chunks.find((c) => c.type === "tool-output-available")!;
      expect((output as { output: unknown }).output).toBe("found: ch. 42");
      const deltas = chunks
        .filter((c) => c.type === "text-delta")
        .map((c) => (c as { delta: string }).delta)
        .join("");
      expect(deltas).toBe("it is 42");
    }),
  );

  it.effect("the REPLAY fold reconstructs text from the halt row", () =>
    Effect.gen(function* () {
      const { trace } = yield* runTurn.pipe(
        Effect.scoped,
        Effect.provide(layers(script)),
      );
      // deltas are live-only: the trace must not contain them…
      expect(trace.every((event) => event.type !== "model.delta")).toBe(true);
      // …and the run's INPUT is a durable fact
      const admitted = trace.find((event) => event.type === "run.admitted")!;
      expect((admitted.payload as { item: unknown }).item).toBe(
        "find the answer",
      );
      const session = admitted.session!;
      const chunks = yield* Stream.runCollect(
        toChunks(sessionEvents(Stream.fromIterable(trace), session)),
      );
      // same protocol, text synthesized as one block at the halt
      expect(chunks.map((chunk) => chunk.type)).toEqual([
        "start",
        "start-step",
        "tool-input-start",
        "tool-input-available",
        "tool-output-available",
        "finish-step",
        "start-step",
        "text-start",
        "text-delta",
        "text-end",
        "finish-step",
        "finish",
      ]);
      const delta = chunks.find((c) => c.type === "text-delta")!;
      expect((delta as { delta: string }).delta).toBe("it is 42");
    }),
  );

  it.effect("reasoning streams live and is absent from replay by design", () =>
    Effect.gen(function* () {
      const reasoningScript: ReadonlyArray<Turn> = [
        () =>
          [
            { type: "reasoning-start", id: "r1" },
            { type: "reasoning-delta", id: "r1", delta: "the corpus " },
            { type: "reasoning-delta", id: "r1", delta: "says 42" },
            { type: "reasoning-end", id: "r1" },
            ...text("it is 42"),
            finish("stop"),
          ] as unknown as Array<Response.StreamPartEncoded>,
      ];
      const { live, trace } = yield* runTurn.pipe(
        Effect.scoped,
        Effect.provide(layers(reasoningScript)),
      );
      const session = live.find((e) => e.session !== undefined)!.session!;

      // LIVE: reasoning block precedes the text block, correctly fenced
      const chunks = yield* Stream.runCollect(
        toChunks(sessionEvents(Stream.fromIterable(live), session)),
      );
      expect(chunks.map((chunk) => chunk.type)).toEqual([
        "start",
        "start-step",
        "reasoning-start",
        "reasoning-delta",
        "reasoning-delta",
        "reasoning-end",
        "text-start",
        "text-delta",
        "text-end",
        "finish-step",
        "finish",
      ]);
      const reasoning = chunks
        .filter((c) => c.type === "reasoning-delta")
        .map((c) => (c as { delta: string }).delta)
        .join("");
      expect(reasoning).toBe("the corpus says 42");

      // REPLAY: reasoning is live-only — no reasoning chunks, text intact
      const replayed = yield* Stream.runCollect(
        toChunks(sessionEvents(Stream.fromIterable(trace), session)),
      );
      expect(replayed.every((c) => !c.type.startsWith("reasoning"))).toBe(true);
      const replayText = replayed
        .filter((c) => c.type === "text-delta")
        .map((c) => (c as { delta: string }).delta)
        .join("");
      expect(replayText).toBe("it is 42");
    }),
  );

  it.effect("live and replay folds agree on the final assistant text", () =>
    Effect.gen(function* () {
      const { live, trace } = yield* runTurn.pipe(
        Effect.scoped,
        Effect.provide(layers(script)),
      );
      const session = trace.find((e) => e.type === "run.admitted")!.session!;
      const textOf = (events: ReadonlyArray<AI.KernelEvent>) =>
        Stream.runCollect(
          toChunks(sessionEvents(Stream.fromIterable(events), session)),
        ).pipe(
          Effect.map((chunks) =>
            chunks
              .filter((c) => c.type === "text-delta")
              .map((c) => (c as { delta: string }).delta)
              .join(""),
          ),
        );
      expect(yield* textOf([...live])).toBe(yield* textOf([...trace]));
    }),
  );
});
