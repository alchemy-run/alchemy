import * as Binding from "alchemy/Binding";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { Agent } from "./Agent.ts";
import { AgentApiKey } from "./AgentApiKey.ts";
import {
  AgentBindingNotConfigured,
  AgentInvocationError,
  ChatCompletion,
  InvokeAgent,
  type InvokeAgentClient,
  type InvokeAgentRequest,
} from "./InvokeAgent.ts";

const envKey = (agent: Agent, field: string) =>
  `DO_AGENT_${agent.LogicalId}_${field}`.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_");

const decodeCompletion = Schema.decodeUnknownEffect(ChatCompletion);

/**
 * `InvokeAgent` over the agent's OpenAI-compatible chat endpoint, with an
 * `AgentApiKey` minted for the host.
 *
 * @layer
 * @product GenAI Platform
 * @provides DigitalOcean.GenAI.InvokeAgent
 */
export const InvokeAgentHttp = Layer.effect(
  InvokeAgent,
  Effect.gen(function* () {
    // The key resource is resolved once, when the layer is built; a host
    // bundle never declares it.
    const AgentKey = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* AgentApiKey;
    const http = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));

    return Effect.fn(function* (agent: Agent) {
      if (AgentKey !== undefined) {
        const host = yield* Binding.Host;
        const runtime = yield* CurrentRuntimeContext;
        if (host !== undefined && runtime !== undefined) {
          const key = yield* AgentKey(`${host.LogicalId}${agent.LogicalId}Key`, {
            agentId: agent.agentId,
          });
          yield* runtime.set(envKey(agent, "endpoint"), agent.endpoint);
          yield* runtime.set(envKey(agent, "key"), key.secretKey);
        }
      }

      // Read in the construction phase, where the host's runtime context is
      // present; request handlers close over the values.
      const runtime = globalThis.__ALCHEMY_RUNTIME__ ? yield* CurrentRuntimeContext : undefined;
      const endpoint =
        runtime === undefined ? undefined : yield* runtime.get<string>(envKey(agent, "endpoint"));
      const key =
        runtime === undefined
          ? undefined
          : yield* runtime.get<string | Redacted.Redacted<string>>(envKey(agent, "key"));

      const chat = Effect.fn(`DigitalOcean.GenAI.InvokeAgent(${agent.LogicalId})`)(function* (
        request: InvokeAgentRequest,
      ) {
        if (!endpoint || key === undefined) {
          return yield* new AgentBindingNotConfigured({ agent: agent.LogicalId });
        }
        const fail = (status: number | undefined, body: string) =>
          new AgentInvocationError({ agent: agent.LogicalId, status, body });
        // The agent's own endpoint, as the API returned it.
        const response = yield* HttpClientRequest.post(
          `${endpoint.replace(/\/$/, "")}/api/v1/chat/completions`,
        ).pipe(
          HttpClientRequest.bearerToken(typeof key === "string" ? key : Redacted.value(key)),
          HttpClientRequest.bodyJsonUnsafe({
            messages: request.messages,
            temperature: request.temperature,
            max_tokens: request.maxTokens,
            stream: false,
          }),
          http.execute,
          Effect.mapError((error) => fail(undefined, error.message)),
        );
        const text = yield* response.text.pipe(
          Effect.mapError((error) => fail(response.status, error.message)),
        );
        if (response.status >= 300) return yield* fail(response.status, text);
        return yield* Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: () => fail(response.status, text),
        }).pipe(
          Effect.flatMap(decodeCompletion),
          Effect.mapError((error) =>
            error._tag === "DigitalOcean.GenAI.AgentInvocationError"
              ? error
              : fail(response.status, `unexpected reply: ${text}`),
          ),
        );
      });

      return {
        chat,
        ask: (prompt) =>
          chat({ messages: [{ role: "user", content: prompt }] }).pipe(
            Effect.map((completion) => completion.choices[0]?.message.content ?? ""),
          ),
      } satisfies InvokeAgentClient;
    });
  }),
);
