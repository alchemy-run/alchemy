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
  Classify,
  CloseIssueLive,
  Engineering,
  EngineeringLive,
  Helper,
  Issues,
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

// member agents + the routing classifier — each its own Layer (its own
// tool physics), the terms-vs-layers pattern
const SageLive = AI.layer(Sage).pipe(
  Layer.provide([kernelLayer, ReadFileLive, RuntimeContext.phantom]),
);
const ScoutLive = AI.layer(Scout).pipe(
  Layer.provide([kernelLayer, RuntimeContext.phantom]),
);
const HelperLive = AI.layer(Helper).pipe(
  Layer.provide([kernelLayer, RuntimeContext.phantom]),
);
const ClassifyLive = AI.layer(Classify).pipe(
  Layer.provide([kernelLayer, RuntimeContext.phantom]),
);

// #engineering: the DETERMINISTIC coordinator (AI.process) — provided
// its classifier + members; #support: the PROSE coordinator; #issues:
// the goal with a machine-observed exit
const EngineeringLayer = EngineeringLive.pipe(
  Layer.provide([kernelLayer, ClassifyLive, SageLive, ScoutLive, RuntimeContext.phantom]),
);
const SupportLayer = AI.layer(Support).pipe(
  Layer.provide([kernelLayer, HelperLive, PostReplyLive, RuntimeContext.phantom]),
);
const IssuesLayer = AI.layer(Issues).pipe(
  Layer.provide([
    kernelLayer,
    SageLive,
    CloseIssueLive,
    AI.EventBusMemory,
    RuntimeContext.phantom,
  ]),
);

const SessionsLive = Layer.effect(
  AI.Api.ChatSessions,
  Effect.gen(function* () {
    // resolve the interpreted process tags (provided by the Layers below)
    const engineering = yield* Engineering;
    const support = yield* Support;
    const issues = yield* Issues;
    const sage = yield* Sage;
    const scout = yield* Scout;
    const helper = yield* Helper;

    return AI.Api.ChatSessions.of(
      yield* AI.Api.makeChatSessions({
        processes: {
          engineering,
          support,
          issues,
          "dm:Sage": sage,
          "dm:Scout": scout,
          "dm:Helper": helper,
        },
      }),
    );
  }),
).pipe(
  Layer.provide([
    EngineeringLayer,
    SupportLayer,
    IssuesLayer,
    SageLive,
    ScoutLive,
    HelperLive,
    kernelLayer,
    AI.AskHubMemory,
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
