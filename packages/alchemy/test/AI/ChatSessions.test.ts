/**
 * ChatSessions — the serving tier's conversation view over a real
 * (scripted) kernel: send admits to the ring and windows the run as
 * protocol chunks; the transcript materializes both halves; asks
 * surface and answer through the same service.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as Stream from "effect/Stream";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as Response from "effect/unstable/ai/Response";
import { makeChatSessions } from "@/AI/Api/ChatSessions.ts";
import type { UIMessage } from "@/AI/Api/Protocol.ts";
import * as AI from "@/AI/index.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";

// ─── fixtures ────────────────────────────────────────────────────

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
  const prompts: LanguageModel.ProviderOptions[] = [];
  const layer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.die(new Error("streamText only")),
      streamText: (options) =>
        Stream.suspend(() => {
          prompts.push(options);
          const turn = script[calls++];
          if (turn === undefined) throw new Error("script exhausted");
          return Stream.fromIterable(turn());
        }),
    }),
  );
  return { layer, prompts };
};

/** All text content of a model call's prompt, flattened. */
const promptText = (options: LanguageModel.ProviderOptions): string =>
  options.prompt.content
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.map((part) =>
            "text" in part ? String(part.text) : "",
          ),
    )
    .join("\n");

const userMessage = (id: string, textContent: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: textContent }],
});

const layers = (model: { layer: Layer.Layer<any> }) =>
  Layer.mergeAll(
    AI.memory.pipe(Layer.provide([model.layer, AI.AskHubMemory])),
    AI.AskHubMemory,
    Layer.succeed(Grep, (() => Effect.succeed("found: ch. 42")) as never),
    RuntimeContext.phantom,
  );

describe("ChatSessions", () => {
  it.effect("send windows the run and materializes the transcript", () =>
    Effect.gen(function* () {
      const model = scriptedModel([
        () => [
          toolCall("c1", "grep", { pattern: "answer" }),
          finish("tool-calls"),
        ],
        () => [...text("it is ", "42"), finish("stop")],
      ]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const kernel = yield* AI.Kernel;
          const librarian = yield* kernel.interpret(Librarian);
          const sessions = yield* makeChatSessions({ process: librarian });

          const chunks = yield* Stream.runCollect(
            sessions.send("conv-1", userMessage("u1", "find the answer")),
          );

          // the window is the protocol stream
          expect(chunks[0]!.type).toBe("start");
          expect(chunks[chunks.length - 1]!.type).toBe("finish");
          const deltas = chunks
            .filter((c) => c.type === "text-delta")
            .map((c) => (c as { delta: string }).delta)
            .join("");
          expect(deltas).toBe("it is 42");

          // the transcript materialized both halves
          const transcript = yield* sessions.transcript("conv-1");
          expect(transcript).toHaveLength(2);
          expect(transcript[0]!.role).toBe("user");
          expect(transcript[1]!.role).toBe("assistant");
          const parts = transcript[1]!.parts;
          const tool = parts.find((p) => p.type === "dynamic-tool")!;
          expect(tool.toolName).toBe("grep");
          expect(tool.state).toBe("output-available");
          expect(tool.output).toBe("found: ch. 42");
          const textPart = parts.find((p) => p.type === "text")!;
          expect(textPart.text).toBe("it is 42");

          // other conversations are untouched
          expect(yield* sessions.transcript("conv-2")).toHaveLength(0);
        }),
      ).pipe(Effect.provide(layers(model)));
    }),
  );

  it.effect("consecutive sends serialize on the ring, one view each", () =>
    Effect.gen(function* () {
      const model = scriptedModel([
        () => [...text("first"), finish("stop")],
        () => [...text("second"), finish("stop")],
      ]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const kernel = yield* AI.Kernel;
          const librarian = yield* kernel.interpret(Librarian);
          const sessions = yield* makeChatSessions({ process: librarian });

          yield* Stream.runDrain(
            sessions.send("conv-1", userMessage("u1", "one")),
          );
          yield* Stream.runDrain(
            sessions.send("conv-1", userMessage("u2", "two")),
          );

          const transcript = yield* sessions.transcript("conv-1");
          expect(transcript.map((m) => m.role)).toEqual([
            "user",
            "assistant",
            "user",
            "assistant",
          ]);
          expect(
            transcript[1]!.parts.find((p) => p.type === "text")!.text,
          ).toBe("first");
          expect(
            transcript[3]!.parts.find((p) => p.type === "text")!.text,
          ).toBe("second");

          // REGRESSION (the amnesia bug): turn 2's work item must carry
          // the conversation — the model's second call sees turn 1's
          // user text AND assistant reply, not just "two"
          expect(model.prompts).toHaveLength(2);
          const secondPrompt = promptText(model.prompts[1]!);
          expect(secondPrompt).toContain("one");
          expect(secondPrompt).toContain("first");
          expect(secondPrompt).toContain("two");
          // and turn 1's call saw no phantom history
          expect(promptText(model.prompts[0]!)).not.toContain("two");
        }),
      ).pipe(Effect.provide(layers(model)));
    }),
  );

  it.effect("conversation ids route to their target process by prefix", () =>
    Effect.gen(function* () {
      class Desk extends AI.Agent<Desk>()("Desk")`You are the desk.` {}
      const model = scriptedModel([
        () => [...text("desk here"), finish("stop")],
        () => [...text("librarian here"), finish("stop")],
      ]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const kernel = yield* AI.Kernel;
          const librarian = yield* kernel.interpret(Librarian);
          const desk = yield* kernel.interpret(Desk);
          const sessions = yield* makeChatSessions({
            processes: { "dm:Desk": desk, general: librarian },
          });

          yield* Stream.runDrain(
            sessions.send("dm:Desk/main", userMessage("u1", "hi desk")),
          );
          yield* Stream.runDrain(
            sessions.send("general/post-1", userMessage("u2", "hi general")),
          );

          // each ring's trace holds ITS admission — routing was real
          const deskTrace = yield* Stream.runCollect(
            kernel
              .trace("Desk")
              .pipe(Stream.takeUntil((e) => e.type === "turn.halted")),
          );
          expect(
            (deskTrace.find((e) => e.type === "run.admitted")!.payload as any)
              .item,
          ).toBe("hi desk");
          const libTrace = yield* Stream.runCollect(
            kernel
              .trace("Librarian")
              .pipe(Stream.takeUntil((e) => e.type === "turn.halted")),
          );
          expect(
            (libTrace.find((e) => e.type === "run.admitted")!.payload as any)
              .item,
          ).toBe("hi general");

          // transcripts stay per-conversation
          expect(yield* sessions.transcript("dm:Desk/main")).toHaveLength(2);
          expect(yield* sessions.transcript("general/post-1")).toHaveLength(2);
        }),
      ).pipe(Effect.provide(layers(model)));
    }),
  );

  it.effect("a parked ask surfaces as a data-ask part and answers back", () =>
    Effect.gen(function* () {
      const action = AI.Parameter("action", S.String)`what needs approval`;
      class RequestApproval extends AI.Tool<RequestApproval>()(
        "request_approval",
      )`Request human approval for ${action}.` {}
      class Steward extends AI.Agent<Steward>()("Steward")`
You are the steward. ALWAYS call ${RequestApproval} before answering.` {}

      const script: ReadonlyArray<Turn> = [
        () => [
          toolCall("c1", "request_approval", { action: "open the vault" }),
          finish("tool-calls"),
        ],
        () => [...text("approved and done"), finish("stop")],
      ];
      const ApprovalLive = Layer.succeed(RequestApproval, ((input: {
        action: string;
      }) =>
        Effect.gen(function* () {
          const ask = yield* AI.Ask;
          const answer = yield* ask({ kind: "approval", text: input.action });
          return answer.verdict;
        })) as never);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const kernel = yield* AI.Kernel;
          const steward = yield* kernel.interpret(Steward);
          const sessions = yield* makeChatSessions({ process: steward });

          const window = yield* Effect.forkChild(
            Stream.runCollect(
              sessions.send("conv-1", userMessage("u1", "open the vault")),
            ),
          );

          // the ask parks; the answering side sees it via the SAME
          // service (clock-free yield poll — TestClock freezes schedules)
          const pending = yield* Effect.gen(function* () {
            for (let spins = 0; spins < 10_000; spins++) {
              const asks = yield* sessions.asks;
              if (asks.length > 0) return asks;
              yield* Effect.yieldNow;
            }
            return yield* Effect.die(new Error("no ask ever parked"));
          });
          expect(pending[0]!.payload.text).toBe("open the vault");

          yield* sessions.answer(pending[0]!.id, { verdict: "approved" });
          const chunks = yield* Fiber.join(window);

          // pending → answered, reconciled on one stable part id
          const askChunks = chunks.filter((c) => c.type === "data-ask");
          expect(askChunks).toHaveLength(2);
          expect(
            (askChunks[0] as { data: { status: string } }).data.status,
          ).toBe("pending");
          expect(
            (askChunks[1] as { data: { status: string } }).data.status,
          ).toBe("answered");
          expect(askChunks[0]!.id).toBe(askChunks[1]!.id);

          // the transcript keeps the ANSWERED ask (latest wins by id)
          const transcript = yield* sessions.transcript("conv-1");
          const askPart = transcript[1]!.parts.find(
            (p) => p.type === "data-ask",
          )!;
          expect((askPart.data as { status: string }).status).toBe("answered");
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            AI.memory.pipe(
              Layer.provide([scriptedModel(script).layer, AI.AskHubMemory]),
            ),
            AI.AskHubMemory,
            ApprovalLive,
            RuntimeContext.phantom,
          ),
        ),
      );
    }),
  );
});
