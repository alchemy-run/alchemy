import { AlchemyContext } from "@/AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "@/Artifacts.ts";
import { AuthProviders } from "@/Auth/AuthProvider.ts";
import * as CliKit from "@/Cli/CliKit/index.ts";
import * as GitHub from "@/GitHub";
import { GitHubCredentials } from "@/GitHub/Credentials.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { v4 as uuidv4 } from "uuid";

const services = (config: Record<string, unknown>) =>
  Layer.mergeAll(
    Layer.succeed(AuthProviders, {}),
    Layer.succeed(Stage, "test"),
    Layer.succeed(Stack, {
      name: "test",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
    }),
    Layer.succeed(AlchemyContext, {
      dev: false,
      adopt: false,
      dotAlchemy: ".alchemy",
    }),
    Layer.succeed(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown(config),
    ),
    Layer.sync(ArtifactStore, createArtifactStore),
    NodeServices.layer,
    FetchHttpClient.layer,
  );

it.live(
  "GitHub providers defer unknown explicit profile errors until credentials are requested",
  () =>
    Effect.gen(function* () {
      const providers = yield* Layer.build(GitHub.providers());
      const result = yield* Effect.result(
        Effect.sandbox(Context.get(providers, GitHubCredentials)),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("does not exist");
        expect(String(result.failure)).toContain("alchemy profile create");
      }
    }).pipe(
      Effect.provide(services({ ALCHEMY_PROFILE: `non-existent-${uuidv4()}` })),
      Effect.provide(CliKit.layer({ input: false })),
    ),
  { tags: ["unit", "provider:github", "local"] },
);

it.live(
  "builds GitHub providers from CI environment credentials without a profile",
  () =>
    Effect.gen(function* () {
      const providers = yield* Layer.build(GitHub.providers());
      const credentials = yield* Context.get(providers, GitHubCredentials);
      expect(Redacted.value(credentials.token)).toBe("test-token");
    }).pipe(
      Effect.provide(
        services({
          CI: true,
          GITHUB_TOKEN: "test-token",
          ALCHEMY_PROFILE: `non-existent-${uuidv4()}`,
        }),
      ),
      Effect.provide(CliKit.layer({ input: false })),
    ),
  { tags: ["unit", "provider:github", "local"] },
);
