import type { AIGateway } from "@/Neon/AIGateway.ts";
import { backendEnvKey } from "@/Neon/BackendConnection.ts";
import {
  ConnectAIGateway,
  ConnectAIGatewayBinding,
  ConnectAIGatewayHttp,
} from "@/Neon/ConnectAIGateway.ts";
import { FunctionEnvironment } from "@/Neon/FunctionEnvironment.ts";
import * as Output from "@/Output.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { expect, test } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const gateway: AIGateway = {
  FQN: "Gateway",
  LogicalId: "Gateway",
  Props: { branch: { projectId: "project", branchId: "branch" } },
  projectId: Output.literal("project"),
  branchId: Output.literal("branch"),
  baseUrl: Output.literal("https://branch.invalid"),
  credential: undefined,
};

for (const mode of ["native", "http"] as const) {
  test.effect(
    `${mode} binding exposes a runtime model layer and only the scoped redacted token`,
    () =>
      Effect.gen(function* () {
        const previous = yield* Effect.sync(() => {
          const previous = globalThis.__ALCHEMY_RUNTIME__;
          globalThis.__ALCHEMY_RUNTIME__ = true;
          return previous;
        });
        yield* Effect.gen(function* () {
          const client = yield* ConnectAIGateway(gateway);
          expect(Layer.isLayer(client.model({ model: "gpt-5-mini" }))).toBe(
            true,
          );
          expect(yield* client.chatBaseUrl).toBe("https://branch.invalid/v1");
          expect(yield* client.responsesBaseUrl).toBe(
            "https://branch.invalid/openai/v1",
          );
          expect(yield* client.anthropicBaseUrl).toBe(
            "https://branch.invalid/anthropic",
          );
          const token = yield* client.token;
          expect(Redacted.isRedacted(token)).toBe(true);
          expect(Redacted.value(token)).toBe(
            mode === "native" ? "native-scoped-token" : "http-scoped-token",
          );
          expect(JSON.stringify(token)).not.toContain("scoped-token");
        }).pipe(
          Effect.provide(
            mode === "native" ? ConnectAIGatewayBinding : ConnectAIGatewayHttp,
          ),
          Effect.provideService(FunctionEnvironment, {
            NEON_AI_GATEWAY_BASE_URL: "https://branch.invalid",
            NEON_AI_GATEWAY_TOKEN: "native-scoped-token",
            NEON_API_KEY: "DO_NOT_BIND_ACCOUNT_KEY",
          }),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              [backendEnvKey(gateway.FQN, "AI_GATEWAY_URL")]:
                "https://branch.invalid",
              [backendEnvKey(gateway.FQN, "AI_GATEWAY_TOKEN")]:
                "http-scoped-token",
            }),
          ),
          Effect.provide(RuntimeContext.phantom),
          Effect.ensuring(
            Effect.sync(() => {
              globalThis.__ALCHEMY_RUNTIME__ = previous;
            }),
          ),
        );
      }),
    { exclusive: true },
  );
}
