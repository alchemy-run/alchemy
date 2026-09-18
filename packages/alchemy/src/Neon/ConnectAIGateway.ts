import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { LanguageModel } from "effect/unstable/ai/LanguageModel";
import * as Binding from "../Binding.ts";
import * as Output from "../Output.ts";
import { isResource } from "../Resource.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { AIGateway } from "./AIGateway.ts";
import {
  backendEnvKey,
  backendSecret,
  backendString,
  bindBackendEnvironment,
} from "./BackendConnection.ts";
import { Credential, validateCredential } from "./Credential.ts";
import { FunctionEnvironment } from "./FunctionEnvironment.ts";
import {
  makeLanguageModelLayer,
  type LanguageModelOptions,
} from "./LanguageModel.ts";

export interface ConnectAIGatewayClient {
  /** Bare gateway root for SDKs that handle their own routing. */
  baseUrl: Effect.Effect<string, never, RuntimeContext>;
  /** OpenAI Chat Completions base URL, ending in /v1. */
  chatBaseUrl: Effect.Effect<string, never, RuntimeContext>;
  /** OpenAI Responses base URL, ending in /openai/v1. */
  responsesBaseUrl: Effect.Effect<string, never, RuntimeContext>;
  /** Native Anthropic SDK base URL, ending in /anthropic (without /v1). */
  anthropicBaseUrl: Effect.Effect<string, never, RuntimeContext>;
  /** Redacted branch-service bearer credential with ai_gateway:invoke access. */
  token: Effect.Effect<Redacted.Redacted<string>, never, RuntimeContext>;
  /** Effect AI using Chat Completions, with no inference during deployment. */
  model(
    options: LanguageModelOptions,
  ): Layer.Layer<LanguageModel, never, RuntimeContext>;
}

/**
 * Obtain an Effect AI LanguageModel or SDK-compatible endpoint and credential
 * effects; no model calls happen during deployment. Native bindings use Neon's
 * injected branch grant. That grant is available to the whole Function process,
 * so a binding is not a
 * Function-level permission sandbox. HTTP bindings use tracked branch credentials.
 *
 * ### Configure a model client
 * **Example:** OpenAI-compatible chat configuration
 * ```typescript
 * const ai = yield* Neon.ConnectAIGateway(gateway);
 * // Inside the request handler:
 * const baseURL = yield* ai.chatBaseUrl;
 * const apiKey = yield* ai.token;
 * ```
 *
 * ### Use Effect AI
 * **Example:** Generate text in a request handler
 * ```typescript
 * const ai = yield* Neon.ConnectAIGateway(gateway);
 * const model = ai.model({ model: "gpt-5-mini" });
 * // Inside a Function or Worker handler:
 * const reply = yield* LanguageModel.generateText({ prompt: "Say hello." }).pipe(
 *   Effect.provide(model),
 * );
 * ```
 *
 * `model` uses Chat Completions, including for Claude models. For Responses-only
 * models or native Anthropic features, use `responsesBaseUrl` or
 * `anthropicBaseUrl` with the corresponding SDK and the redacted `token`.
 *
 * @binding
 * @product AI Gateway
 * @category AI Gateway
 */
export interface ConnectAIGateway extends Binding.Service<
  ConnectAIGateway,
  "Neon.ConnectAIGateway",
  (gateway: AIGateway) => Effect.Effect<ConnectAIGatewayClient>
> {}
export const ConnectAIGateway = Binding.Service<ConnectAIGateway>(
  "Neon.ConnectAIGateway",
);

const client = (
  baseUrl: ConnectAIGatewayClient["baseUrl"],
  token: ConnectAIGatewayClient["token"],
): ConnectAIGatewayClient => {
  const chatBaseUrl = baseUrl.pipe(
    Effect.map((base) => `${base.replace(/\/$/, "")}/v1`),
  );
  return {
    baseUrl,
    token,
    chatBaseUrl,
    responsesBaseUrl: baseUrl.pipe(
      Effect.map((base) => `${base.replace(/\/$/, "")}/openai/v1`),
    ),
    anthropicBaseUrl: baseUrl.pipe(
      Effect.map((base) => `${base.replace(/\/$/, "")}/anthropic`),
    ),
    model: (options) =>
      makeLanguageModelLayer({
        ...options,
        client: { chatBaseUrl, token },
      }),
  };
};

/** Native Neon Function binding. Cross-branch access must use ConnectAIGatewayHttp. */
export const ConnectAIGatewayBinding = Layer.effect(
  ConnectAIGateway,
  Effect.gen(function* () {
    const environment = yield* FunctionEnvironment;
    const connectAIGatewayHttp = yield* makeConnectAIGatewayHttp;
    return Effect.fn(function* (gateway: AIGateway) {
      if (gateway.credential) return yield* connectAIGatewayHttp(gateway);
      const key = backendEnvKey(gateway.FQN, "AI_GATEWAY_URL");
      yield* bindBackendEnvironment(`Neon.ConnectAIGateway:${gateway.FQN}`, {
        [key]: gateway.baseUrl,
      });
      const baseUrl = backendString(key).pipe(
        Effect.flatMap((expected) => {
          const injected = environment.NEON_AI_GATEWAY_BASE_URL?.replace(
            /\/$/,
            "",
          );
          return injected === expected.replace(/\/$/, "")
            ? Effect.succeed(injected)
            : Effect.die(
                new Error(
                  "AI Gateway injection does not match the target branch; use ConnectAIGatewayHttp for cross-branch or local access",
                ),
              );
        }),
      );
      const token = baseUrl.pipe(
        Effect.flatMap(() =>
          environment.NEON_AI_GATEWAY_TOKEN
            ? Effect.succeed(Redacted.make(environment.NEON_AI_GATEWAY_TOKEN))
            : Effect.die(
                new Error("Neon did not inject an AI Gateway credential"),
              ),
        ),
      );
      return client(baseUrl, token);
    });
  }),
);

/**
 * HTTP/secret-binding implementation for Workers, Lambda, local Functions and
 * cross-branch use. Owns a deterministic ai_gateway:invoke credential unless the
 * construct supplies one. The deployment API key is never bound to the host.
 */
const makeConnectAIGatewayHttp = Effect.gen(function* () {
  const createCredential = yield* Credential;
  return Effect.fn(function* (gateway: AIGateway) {
    const urlKey = backendEnvKey(gateway.FQN, "AI_GATEWAY_URL");
    const tokenKey = backendEnvKey(gateway.FQN, "AI_GATEWAY_TOKEN");
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const host = yield* Binding.Host;
      if (!host)
        return yield* Effect.die(
          new Error("ConnectAIGatewayHttp requires a Function or Worker host"),
        );
      const scope = gateway.Props.branch ?? gateway.Props.project;
      const scopeId = isResource(scope)
        ? `${scope.Type}:${scope.FQN}`
        : gateway.Props.branch &&
            typeof gateway.Props.branch.projectId === "string" &&
            typeof gateway.Props.branch.branchId === "string"
          ? `branch:${gateway.Props.branch.projectId}:${gateway.Props.branch.branchId}`
          : gateway.Props.project &&
              typeof gateway.Props.project.projectId === "string"
            ? `project:${gateway.Props.project.projectId}`
            : gateway.FQN;
      const credentialId = yield* Effect.sync(() =>
        createHash("sha256")
          .update(`${host.FQN}:${scopeId}:ai_gateway:invoke`)
          .digest("hex")
          .slice(0, 24),
      );
      const credential =
        gateway.credential ??
        (yield* createCredential(`AIGateway${credentialId}`, {
          ...(gateway.Props.branch !== undefined
            ? { branch: gateway.Props.branch }
            : { project: gateway.Props.project }),
          scopes: ["ai_gateway:invoke"],
        }));
      const token = Output.all(
        credential.projectId,
        credential.branchId,
        credential.scopes,
        gateway.projectId,
        gateway.branchId,
        credential.apiToken,
      ).pipe(
        Output.mapEffect(
          ([
            projectId,
            branchId,
            scopes,
            targetProjectId,
            targetBranchId,
            token,
          ]) =>
            validateCredential(
              { projectId, branchId, scopes },
              { projectId: targetProjectId, branchId: targetBranchId },
              "ai_gateway:invoke",
            ).pipe(Effect.as(token), Effect.orDie),
        ),
      );
      yield* bindBackendEnvironment(`Neon.ConnectAIGateway:${gateway.FQN}`, {
        [urlKey]: gateway.baseUrl,
        [tokenKey]: token,
      });
    }
    return client(backendString(urlKey), backendSecret(tokenKey));
  });
});

/** HTTP transport with tracked, branch-scoped credentials instead of platform injection. */
export const ConnectAIGatewayHttp = Layer.effect(
  ConnectAIGateway,
  makeConnectAIGatewayHttp,
);
