/**
 * The local agent server: an Anthropic-backed alchemy agent served
 * over the AI SDK UI message stream (designs/ai/serving.md).
 *
 *   ANTHROPIC_API_KEY=sk-… bun run server   # port 8787
 *   bun run dev                             # Vite proxies /api + /v1
 *
 * The interesting part is what ISN'T here: no chat loop, no SSE
 * framing, no session bookkeeping. The agent is a term, the kernel
 * interprets it, `ChatSessions` materializes conversations, and
 * `agentApi()` is the whole HTTP surface.
 */
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient";
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as S from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as AI from "alchemy/AI";
import { RuntimeContext } from "alchemy/RuntimeContext";

// ─── the agent ───────────────────────────────────────────────────

const sides = AI.Parameter("sides", S.Number)`how many sides the die has`;
class RollDice extends AI.Tool<RollDice>()("roll_dice")`
Roll a fair die with ${sides} sides and return the result.` {}

const action = AI.Parameter("action", S.String)`the action needing approval`;
class RequestApproval extends AI.Tool<RequestApproval>()("request_approval")`
Ask the human to approve ${action} before you do it. High-stakes
actions (wagers over 50 coins, anything irreversible) require this.` {}

class Croupier extends AI.Agent<Croupier>()("Croupier")`
You are the croupier of a tiny dice parlor. Players chat with you,
wager imaginary coins, and you roll dice for them with ${RollDice}
(never invent rolls). For any wager over 50 coins, get sign-off with
${RequestApproval} first. Keep replies short and playful.` {}

// ─── physics ─────────────────────────────────────────────────────

const RollDiceLive = Layer.succeed(RollDice, ((input: { sides: number }) =>
  Effect.sync(() => ({
    rolled: 1 + Math.floor(Math.random() * Math.max(2, input.sides)),
  }))) as never);

const RequestApprovalLive = Layer.succeed(RequestApproval, ((input: {
  action: string;
}) =>
  Effect.gen(function* () {
    const ask = yield* AI.Ask;
    const answer = yield* ask({ kind: "approval", text: input.action });
    return answer.verdict === "approved"
      ? "approved — proceed"
      : `denied${answer.text ? `: ${answer.text}` : ""}`;
  })) as never);

const ModelLive = AnthropicLanguageModel.layer({
  model: "claude-haiku-4-5",
  config: {
    // extended thinking: reasoning deltas stream to the UI live (they
    // are never journaled — absent from trace replay by design).
    // Keep the budget SMALL and the ceiling ROOMY: thinking counts
    // toward max_tokens, and a runaway think that hits the ceiling
    // ends the turn with finishReason "length" and ZERO visible text.
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

// ─── the serving stack ───────────────────────────────────────────

const kernelLayer = AI.memory.pipe(
  Layer.provide([ModelLive, AI.AskHubMemory]),
);

const SessionsLive = Layer.effect(
  AI.Api.ChatSessions,
  Effect.gen(function* () {
    const kernel = yield* AI.Kernel;
    const process = yield* kernel.interpret(Croupier);
    return AI.Api.ChatSessions.of(
      yield* AI.Api.makeChatSessions({ process }),
    );
  }),
).pipe(
  Layer.provide([
    kernelLayer,
    AI.AskHubMemory,
    RollDiceLive,
    RequestApprovalLive,
    RuntimeContext.phantom,
  ]),
);

// smoothing: providers emit sentence-sized deltas (Anthropic: 50-80+
// chars); re-split into word-paced deltas so the UI paints token flow
const Server = HttpRouter.serve(AI.Api.agentApi({ smoothing: { delayMs: 15 } })).pipe(
  Layer.provide([SessionsLive, kernelLayer]),
  // idleTimeout: 0 — Bun.serve defaults to killing connections idle
  // for 10s, which severs SSE windows mid-run
  Layer.provide(BunHttpServer.layer({ port: 8787, idleTimeout: 0 })),
);

BunRuntime.runMain(Layer.launch(Server));
