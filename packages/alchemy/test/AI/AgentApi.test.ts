/**
 * The serving surface end to end: a real Bun HTTP server (ephemeral
 * test port) in front of a scripted kernel, driven through a real
 * HttpClient — the same wire a `useChat` client sees.
 */
import { describe, expect, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as Response from "effect/unstable/ai/Response";
import { agentApi } from "@/AI/Api/AgentApi.ts";
import { ChatSessions, makeChatSessions } from "@/AI/Api/ChatSessions.ts";
import * as AI from "@/AI/index.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";

// ─── fixtures ────────────────────────────────────────────────────

const pattern = AI.Parameter("pattern", S.String)`the regex to search for`;
class Grep extends AI.Tool<Grep>()("grep")`
Search the corpus for ${pattern}.` {}
class Librarian extends AI.Agent<Librarian>()("Librarian")`
You are the librarian. Use ${Grep} to find passages before answering.` {}

const action = AI.Parameter("action", S.String)`what needs approval`;
class RequestApproval extends AI.Tool<RequestApproval>()("request_approval")`
Request human approval for ${action}.` {}
class Steward extends AI.Agent<Steward>()("Steward")`
You are the steward. ALWAYS call ${RequestApproval} before answering.` {}

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

/**
 * The whole serving stack for one interpreted term: kernel + sessions
 * + routes + a real Bun server on an ephemeral port, with the test
 * client pointed at it.
 */
const appLayer = (
  term: typeof Librarian | typeof Steward,
  script: ReadonlyArray<Turn>,
  tools: Layer.Layer<any>,
) => {
  const kernelLayer = AI.memory.pipe(
    Layer.provide([scriptedModel(script), AI.AskHubMemory]),
  );
  const SessionsLive = Layer.effect(
    ChatSessions,
    Effect.gen(function* () {
      const kernel = yield* AI.Kernel;
      const process = yield* kernel.interpret(term as typeof Librarian);
      return ChatSessions.of(yield* makeChatSessions({ process }));
    }),
  ).pipe(
    Layer.provide([
      kernelLayer,
      AI.AskHubMemory,
      tools,
      RuntimeContext.phantom,
    ]),
  );

  // provideMerge keeps the test client (pointed at the ephemeral
  // server) in the layer's output for the test body to use
  return HttpRouter.serve(agentApi(), { disableListenLog: true }).pipe(
    Layer.provide([SessionsLive, kernelLayer]),
    Layer.provideMerge(NodeHttpServer.layerTest),
  );
};

const chatBody = (conversationId: string, textContent: string) => ({
  id: conversationId,
  trigger: "submit-message",
  messages: [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: textContent }],
    },
  ],
});

const postJson = (url: string, body: unknown) =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    client.execute(
      HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
    ),
  );

describe("the agent HTTP API", () => {
  it.effect("POST /api/chat speaks the AI SDK UI message stream", () =>
    Effect.gen(function* () {
      const response = yield* postJson(
        "/api/chat",
        chatBody("conv-1", "find the answer"),
      );
      expect(response.status).toBe(200);
      expect(response.headers["x-vercel-ai-ui-message-stream"]).toBe("v1");
      expect(response.headers["content-type"]).toContain("text/event-stream");

      const body = yield* response.text;
      const frames = body
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => frame.slice("data: ".length));
      // the envelope: typed chunks, terminated by the [DONE] literal
      expect(frames.at(-1)).toBe("[DONE]");
      const chunks = frames.slice(0, -1).map((f) => JSON.parse(f));
      expect(chunks[0]!.type).toBe("start");
      expect(chunks.at(-1)!.type).toBe("finish");
      const input = chunks.find((c) => c.type === "tool-input-available");
      expect(input.toolName).toBe("grep");
      expect(input.input).toEqual({ pattern: "answer" });
      const deltas = chunks
        .filter((c) => c.type === "text-delta")
        .map((c) => c.delta)
        .join("");
      expect(deltas).toBe("it is 42");

      // GET /api/chat/:id serves the materialized transcript
      const client = yield* HttpClient.HttpClient;
      const transcript = (yield* (yield* client.get("/api/chat/conv-1"))
        .json) as {
        messages: Array<{ role: string }>;
      };
      expect(transcript.messages.map((m) => m.role)).toEqual([
        "user",
        "assistant",
      ]);

      // GET /api/chats indexes the conversation, titled by its first
      // user message
      const index = (yield* (yield* client.get("/api/chats")).json) as {
        conversations: Array<{ id: string; title: string; messages: number }>;
      };
      expect(index.conversations).toEqual([
        { id: "conv-1", title: "find the answer", messages: 2 },
      ]);
    }).pipe(
      Effect.provide(
        appLayer(
          Librarian,
          [
            () => [
              toolCall("c1", "grep", { pattern: "answer" }),
              finish("tool-calls"),
            ],
            () => [...text("it is ", "42"), finish("stop")],
          ],
          Layer.succeed(Grep, (() => Effect.succeed("found: ch. 42")) as never),
        ),
      ),
    ),
  );

  // it.live: real HTTP round-trips paced on the real clock
  it.live(
    "the ask control plane answers a parked run over HTTP",
    () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;

        const window = yield* Effect.forkChild(
          Effect.flatMap(
            postJson("/api/chat", chatBody("conv-a", "open the vault")),
            (response) => response.text,
          ),
        );

        // poll the control plane until the ask parks
        const pending = yield* Effect.gen(function* () {
          for (let spins = 0; spins < 100; spins++) {
            const { asks } = (yield* (yield* client.get("/api/asks")).json) as {
              asks: Array<{ id: string; payload: { text: string } }>;
            };
            if (asks.length > 0) return asks;
            yield* Effect.sleep("100 millis");
          }
          return yield* Effect.die(new Error("no ask ever parked"));
        });
        expect(pending[0]!.payload.text).toBe("open the vault");

        // answer it over HTTP; the parked run resumes and the window closes
        const answered = yield* postJson(
          `/api/asks/${encodeURIComponent(pending[0]!.id)}`,
          { verdict: "approved" },
        );
        expect(answered.status).toBe(200);

        const body = yield* Fiber.join(window);
        expect(body).toContain('"type":"data-ask"');
        expect(body).toContain('"status":"answered"');
        expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);

        // unknown ask ids are a typed 404, not a crash
        const missing = yield* postJson("/api/asks/nope", {
          verdict: "approved",
        });
        expect(missing.status).toBe(404);
      }).pipe(
        Effect.provide(
          appLayer(
            Steward,
            [
              () => [
                toolCall("c1", "request_approval", {
                  action: "open the vault",
                }),
                finish("tool-calls"),
              ],
              () => [...text("approved and done"), finish("stop")],
            ],
            Layer.succeed(RequestApproval, ((input: { action: string }) =>
              Effect.gen(function* () {
                const ask = yield* AI.Ask;
                const answer = yield* ask({
                  kind: "approval",
                  text: input.action,
                });
                return answer.verdict;
              })) as never),
          ),
        ),
      ),
    { timeout: 15_000 },
  );

  it.effect("GET /v1/stream/:ring replays the durable trace window", () =>
    Effect.gen(function* () {
      // run a turn to fill the trace…
      yield* Effect.flatMap(
        postJson("/api/chat", chatBody("conv-t", "find the answer")),
        (response) => response.text,
      );
      // …then window it from offset 0 and take the replayed rows
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("/v1/stream/Librarian?offset=0");
      expect(response.headers["content-type"]).toContain("text/event-stream");
      const framesText = yield* response.stream.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.startsWith("data: ")),
        // the trace tails live forever — take exactly the replay
        Stream.take(8),
        Stream.runCollect,
      );
      const events = framesText.map((line) =>
        JSON.parse(line.slice("data: ".length)),
      );
      expect(events[0].type).toBe("run.admitted");
      expect(events.map((e: { seq: number }) => e.seq)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      expect(events.at(-1).type).toBe("turn.halted");
    }).pipe(
      Effect.provide(
        appLayer(
          Librarian,
          [
            () => [
              toolCall("c1", "grep", { pattern: "answer" }),
              finish("tool-calls"),
            ],
            () => [...text("it is 42"), finish("stop")],
          ],
          Layer.succeed(Grep, (() => Effect.succeed("found: ch. 42")) as never),
        ),
      ),
    ),
  );
});
