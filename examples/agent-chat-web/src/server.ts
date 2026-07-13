/**
 * The org server — THE FRONT DOOR (canon §5: delivery is always code).
 * Channels and agents from ./org.ts, each interpreted onto its own
 * ring. Every delivery is explicit here: the serving tier validates a
 * UI message, adapts it into the typed domain input (`toPostThread` —
 * the anti-corruption seam), routes by target prefix
 * (`engineering/post-…` → the channel ring, `dm:Sage/main` → Sage's
 * ring), and admits it with `send`. No process self-subscribes:
 * `AI.when(PostOpened)` in org.ts is a pure input declaration. The one
 * kernel-internal subscription is the #issues machine exit
 * (`AI.exit(AI.when(IssueClosed), match)`), which observes the world through
 * the shared EventBus. The sidebar is `GET /api/topology`.
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
  type PostThread,
  PostReplyLive,
  ReadFileLive,
  roots,
  Sage,
  Scout,
  Support,
} from "./org.ts";

/**
 * The transport/domain boundary: UI messages become a typed PostThread
 * before they reach any Channel process. Authored data-message and
 * legacy post_reply parts become separate member messages; no raw
 * Prompt objects leak into deterministic orchestration.
 */
const toPostThread = ({
  conversationId,
  history,
  message,
}: AI.Api.ChatTargetInput): PostThread => {
  const [channel, id = conversationId] = conversationId.split("/");
  const messages: Array<PostThread["messages"][number]> = [];
  for (const entry of [...history, message]) {
    if (entry.role === "user") {
      const text = AI.Api.messageText(entry);
      if (text.length > 0) {
        messages.push({ role: "user", author: "You", text });
      }
      continue;
    }
    if (entry.role !== "assistant") continue;
    for (const part of entry.parts) {
      if (part.type === "data-message") {
        const data = (part as unknown as {
          data: { author: string; text: string };
        }).data;
        messages.push({
          role: "assistant",
          author: data.author,
          text: data.text,
        });
        continue;
      }
      if (part.type === "dynamic-tool") {
        const tool = part as unknown as {
          toolName?: string;
          input?: { author?: unknown; text?: unknown };
        };
        if (tool.toolName === "post_reply") {
          messages.push({
            role: "assistant",
            author: String(tool.input?.author ?? "Agent"),
            text: String(tool.input?.text ?? ""),
          });
        }
      }
    }
  }
  return { id, channel: channel ?? "unknown", messages };
};

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

// One shared bus instance: the kernel subscribes to machine-exit
// sources and tool physics publishes onto the SAME bus. Closing these
// Layers independently creates split-brain in-memory topics.
const EventBusLive = AI.EventBusMemory;
const kernelLayer = AI.memory.pipe(
  Layer.provide([ModelLive, AI.AskHubMemory, EventBusLive]),
);

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
  // budget is a Layer, not prose: the same ceiling the charter used to splice
  Layer.provide(AI.budget({ iterations: 6 })),
);
const IssuesLayer = AI.layer(Issues).pipe(
  Layer.provide([
    kernelLayer,
    SageLive,
    CloseIssueLive,
    EventBusLive,
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
        targets: {
          engineering: AI.Api.chatTarget(engineering, toPostThread),
          support: AI.Api.chatTarget(support, toPostThread),
          issues: AI.Api.chatTarget(issues, toPostThread),
        },
        processes: {
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
    EventBusLive,
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
  Layer.provide(
    BunHttpServer.layer({
      port: Number(process.env.PORT ?? 8787),
      idleTimeout: 0,
    }),
  ),
);

BunRuntime.runMain(Layer.launch(Server));
