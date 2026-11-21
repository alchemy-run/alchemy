import {
  AWS_AUTH_PROVIDER_NAME,
  AwsAuth,
  type AwsAuthConfig,
  type AwsResolvedCredentials,
} from "@alchemy.run/aws/AuthProvider";
import { AuthProvidersLive, getAuthProvider } from "alchemy/Auth/AuthProvider";
import * as Interaction from "alchemy/Interaction";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

// Observe the real SDK request, then interrupt before any transport can run.
const httpClient = Layer.effect(
  HttpClient.HttpClient,
  HttpClient.HttpClient.pipe(
    Effect.map(
      HttpClient.mapRequestEffect((request) =>
        Effect.gen(function* () {
          const hostname = yield* Effect.sync(() => new URL(request.url).hostname);
          yield* Console.log(JSON.stringify({ hostname }));
          return yield* Effect.interrupt;
        }),
      ),
    ),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));

await Effect.runPromise(
  Effect.gen(function* () {
    const auth = yield* getAuthProvider<AwsAuthConfig, AwsResolvedCredentials>(
      AWS_AUTH_PROVIDER_NAME,
    );
    // A saved account ID keeps the read path off STS.
    const config = yield* auth.decodeConfig("testing", {
      method: "aws-profile",
      awsProfile: "sandbox",
      accountId: "123456789012",
    });
    const action = yield* Config.String("AWS_PROFILE_TEST_ACTION").pipe(Config.withDefault("read"));
    if (action === "refresh") {
      const result = yield* auth.login("testing", config).pipe(Effect.exit);
      if (result._tag !== "Failure" || !Cause.hasInterruptsOnly(result.cause)) {
        return yield* Effect.die("Expected a request interrupted before transport");
      }
      return;
    }
    const resolved = yield* auth.read("testing", Effect.succeed(config));
    const credentials = yield* resolved.credentials;
    yield* Console.log(
      JSON.stringify({
        accountId: resolved.accountId,
        region: resolved.region,
        credentialRegion: credentials.region,
        processCredentials:
          Redacted.value(credentials.accessKeyId) === "process-key" &&
          Redacted.value(credentials.secretAccessKey) === "process-secret" &&
          credentials.sessionToken !== undefined &&
          Redacted.value(credentials.sessionToken) === "process-token",
        source: resolved.source,
      }),
    );
  }).pipe(
    Effect.provide(
      AwsAuth.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            AuthProvidersLive,
            PlatformServices,
            httpClient,
            ConfigProvider.layer(ConfigProvider.fromEnv()),
            Interaction.layerNonInteractive(),
          ),
        ),
      ),
    ),
  ),
);
