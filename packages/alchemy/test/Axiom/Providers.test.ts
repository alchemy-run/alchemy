import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { v4 as uuidv4 } from "uuid";
import { AlchemyContext } from "@/AlchemyContext.ts";
import { AuthProviders } from "@/Auth/AuthProvider.ts";
import * as Axiom from "@/Axiom";
import { Credentials } from "@/Axiom/Credentials.ts";
import * as CliKit from "@/Cli/CliKit/index.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";

it.live(
  "building Axiom providers does not resolve credentials",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        Effect.sandbox(
          Effect.gen(function* () {
            // The layer builds although the profile does not exist ...
            yield* Axiom.Providers;
            // ... and resolution fails only on first use.
            return yield* Effect.result(
              Effect.sandbox(
                Effect.gen(function* () {
                  return yield* yield* Credentials;
                }),
              ),
            );
          }).pipe(Effect.provide(Axiom.providers())),
        ),
      );
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) {
        const credentials = result.success;
        expect(Result.isFailure(credentials)).toBe(true);
        if (Result.isFailure(credentials)) {
          expect(String(credentials.failure)).toContain("does not exist");
        }
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
          NodeServices.layer,
          FetchHttpClient.layer,
          CliKit.layer({ input: false }),
        ),
      ),
    ),
  { tags: ["unit", "provider:axiom", "local"] },
);
