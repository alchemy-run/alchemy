import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { v4 as uuidv4 } from "uuid";
import { AlchemyContext } from "@/AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "@/Artifacts.ts";
import { AuthProviders } from "@/Auth/AuthProvider.ts";
import * as CliKit from "@/Cli/CliKit/index.ts";
import * as Neon from "@/Neon";
import { Credentials } from "@/Neon/Credentials.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";

it.live(
  "resolving Neon credentials rejects an unknown explicit profile",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        Effect.sandbox(
          Effect.gen(function* () {
            return yield* yield* Credentials;
          }).pipe(Effect.provide(Neon.providers())),
        ),
      );
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
          Layer.succeed(AlchemyContext, { dev: false, adopt: false, dotAlchemy: ".alchemy" }),
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ALCHEMY_PROFILE: `non-existent-${uuidv4()}` }),
          ),
          Layer.sync(ArtifactStore, createArtifactStore),
          NodeServices.layer,
          FetchHttpClient.layer,
          CliKit.layer({ input: false }),
        ),
      ),
    ),
  { tags: ["unit", "provider:neon", "local"] },
);
