import { AlchemyContext } from "@/AlchemyContext.ts";
import { AuthProviders } from "@/Auth/AuthProvider.ts";
import * as SpacetimeDB from "@/SpacetimeDB";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { v4 as uuidv4 } from "uuid";

it.live(
  "building the SpacetimeDB provider layers should not fail for unknown profile",
  () =>
    Effect.gen(function* () {
      yield* Layer.build(SpacetimeDB.providers());
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
          NodeServices.layer,
          FetchHttpClient.layer,
        ),
      ),
    ),
);

describe("fromToken", () => {
  it.effect("resolves the provided token and default Maincloud host", () =>
    Effect.gen(function* () {
      const creds = yield* yield* SpacetimeDB.SpacetimeDBCredentials;
      expect(Redacted.value(creds.token)).toBe("tok-123");
      expect(creds.host).toBe(SpacetimeDB.DEFAULT_HOST);
    }).pipe(Effect.provide(SpacetimeDB.fromToken("tok-123"))),
  );

  it.effect("normalizes a custom host", () =>
    Effect.gen(function* () {
      const creds = yield* yield* SpacetimeDB.SpacetimeDBCredentials;
      expect(creds.host).toBe("http://127.0.0.1:3000");
    }).pipe(
      Effect.provide(SpacetimeDB.fromToken("tok-123", { host: "local" })),
    ),
  );
});
