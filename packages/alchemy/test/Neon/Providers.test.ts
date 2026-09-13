import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { v4 as uuidv4 } from "uuid";
import { AlchemyContext } from "@/AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "@/Artifacts.ts";
import { AuthProviders } from "@/Auth/AuthProvider.ts";
import * as CliKit from "@/Cli/CliKit/index.ts";
import * as Neon from "@/Neon";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";

it.live("building the Neon provider layers rejects an unknown explicit profile", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(Effect.sandbox(Layer.build(Neon.providers())));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(String(result.failure)).toContain("does not exist");
      expect(String(result.failure)).toContain("alchemy profile create");
    }
  }).pipe(
    Effect.provide(
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
          ConfigProvider.fromUnknown({
            ALCHEMY_PROFILE: `non-existent-${uuidv4()}`,
          }),
        ),
        Layer.sync(ArtifactStore, createArtifactStore),
        NodeServices.layer,
        FetchHttpClient.layer,
        CliKit.layer({ input: false }),
      ),
    ),
  ),
);
