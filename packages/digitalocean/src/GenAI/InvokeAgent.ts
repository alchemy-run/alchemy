import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Agent } from "./Agent.ts";

/** One chat message. */
export const ChatMessage = Schema.Struct({
  role: Schema.Literals(["system", "user", "assistant"]),
  content: Schema.String,
});
export type ChatMessage = typeof ChatMessage.Type;

/** A request to the agent's chat endpoint. */
export interface InvokeAgentRequest {
  readonly messages: ReadonlyArray<ChatMessage>;
  /** Sampling temperature, 0 to 1. @default the agent's */
  readonly temperature?: number;
  /** Most tokens in the reply. @default the agent's */
  readonly maxTokens?: number;
}

/** The agent's reply, in the OpenAI chat-completions shape. */
export const ChatCompletion = Schema.Struct({
  id: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  choices: Schema.Array(
    Schema.Struct({
      index: Schema.optional(Schema.Number),
      finish_reason: Schema.String.pipe(Schema.NullOr, Schema.optional),
      message: Schema.Struct({
        role: Schema.String,
        content: Schema.NullOr(Schema.String),
      }),
    }),
  ),
  usage: Schema.optional(
    Schema.Struct({
      prompt_tokens: Schema.Number,
      completion_tokens: Schema.Number,
      total_tokens: Schema.Number,
    }),
  ),
});
export type ChatCompletion = typeof ChatCompletion.Type;

/** The agent's endpoint rejected or failed the call. */
export class AgentInvocationError extends Data.TaggedError(
  "DigitalOcean.GenAI.AgentInvocationError",
)<{
  readonly agent: string;
  readonly status: number | undefined;
  readonly body: string;
}> {
  override get message() {
    return `Agent '${this.agent}' call failed (${this.status ?? "no response"}): ${this.body}`;
  }
}

/** The agent's endpoint or key is missing from this runtime's environment. */
export class AgentBindingNotConfigured extends Data.TaggedError(
  "DigitalOcean.GenAI.AgentBindingNotConfigured",
)<{
  readonly agent: string;
}> {
  override get message() {
    return `Agent '${this.agent}' is not bound to this runtime: its endpoint or key is missing from the environment.`;
  }
}

/** Calls one agent from a runtime. */
export interface InvokeAgentClient {
  /** Sends the conversation and returns the full completion. */
  chat(
    request: InvokeAgentRequest,
  ): Effect.Effect<
    ChatCompletion,
    AgentInvocationError | AgentBindingNotConfigured,
    RuntimeContext
  >;
  /** Sends one user message and returns the reply's text. */
  ask(
    prompt: string,
  ): Effect.Effect<string, AgentInvocationError | AgentBindingNotConfigured, RuntimeContext>;
}

/**
 * Calls a GenAI agent's chat endpoint from a runtime. Binding it mints an
 * `AgentApiKey` for the host, because DigitalOcean signs no workload
 * identity a runtime could present instead; the key travels to the host as
 * a secret.
 *
 * **Example:** Answer questions from an App
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const support = yield* DigitalOcean.GenAI.InvokeAgent(SupportAgent);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const answer = yield* support.ask("How do I reset my password?");
 *         return HttpServerResponse.text(answer);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.GenAI.InvokeAgentHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product GenAI Platform
 */
export interface InvokeAgent extends Binding.Service<
  InvokeAgent,
  "DigitalOcean.GenAI.InvokeAgent",
  (agent: Agent) => Effect.Effect<InvokeAgentClient>
> {}

export const InvokeAgent = Binding.Service<InvokeAgent>("DigitalOcean.GenAI.InvokeAgent");
