/**
 * The org server (designs/ai/org-chat.md): channels and agents from
 * ./org.ts, each interpreted onto its own ring; conversations route by
 * target prefix (`engineering/post-…` → the channel ring,
 * `dm:Sage/main` → Sage's ring); the sidebar is `GET /api/topology`.
 *
 *   ANTHROPIC_API_KEY=sk-… bun run server   # port 8787
 *   bun run dev                             # Vite proxies /api + /v1
 */
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient";
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as AI from "alchemy/AI";
import { RuntimeContext } from "alchemy/RuntimeContext";
import {
  Engineering,
  Helper,
  PostReplyLive,
  ReadFileLive,
  roots,
  Sage,
  Scout,
  Support,
} from "./org.ts";

const ModelLive = AnthropicLanguageModel.layer({
  model: "claude-haiku-4-5",
  config: {
    thinking: { type: "enabled", budget_tokens: 1024 },
    max_tokens: 8192,
  },
}).pipe(
  Layer.provide(
    AnthropicClient.layer({
      apiKey: Redacted.make(process.env.ANTHROPIC_API_KEY ?? ""),
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
);

const kernelLayer = AI.memory.pipe(Layer.provide([ModelLive, AI.AskHubMemory]));

const SessionsLive = Layer.effect(
  AI.Api.ChatSessions,
  Effect.gen(function* () {
    const kernel = yield* AI.Kernel;
    // members first: the channels' delegation tools resolve these tags
    const sage = yield* kernel.interpret(Sage);
    const scout = yield* kernel.interpret(Scout);
    const helper = yield* kernel.interpret(Helper);
    const engineering = yield* kernel
      .interpret(Engineering)
      .pipe(
        Effect.provideService(Sage, sage),
        Effect.provideService(Scout, scout),
      );
    const support = yield* kernel
      .interpret(Support)
      .pipe(Effect.provideService(Helper, helper));

    return AI.Api.ChatSessions.of(
      yield* AI.Api.makeChatSessions({
        processes: {
          engineering,
          support,
          "dm:Sage": sage,
          "dm:Scout": scout,
          "dm:Helper": helper,
        },
      }),
    );
  }),
).pipe(
  Layer.provide([
    kernelLayer,
    AI.AskHubMemory,
    PostReplyLive,
    ReadFileLive,
    RuntimeContext.phantom,
  ]),
);

const Server = HttpRouter.serve(
  AI.Api.agentApi({
    smoothing: { delayMs: 15 },
    topology: roots,
  }),
).pipe(
  Layer.provide([SessionsLive, kernelLayer]),
  // idleTimeout: 0 — Bun.serve defaults to killing connections idle
  // for 10s, which severs SSE windows mid-run
  Layer.provide(BunHttpServer.layer({ port: 8787, idleTimeout: 0 })),
);

BunRuntime.runMain(Layer.launch(Server));
