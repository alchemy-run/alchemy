import { CredentialsFromEnv } from "@distilled.cloud/fly-io";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { GetSecret } from "./GetSecret.ts";
import { makeHttpSecretBinding } from "./SecretHttp.ts";

/**
 * HTTP implementation of {@link GetSecret}.
 *
 * @layer
 * @provides Fly.GetSecret
 */
export const GetSecretHttp = Layer.effect(
  GetSecret,
  Effect.suspend(() =>
    makeHttpSecretBinding({
      makeClient: (auth, appName, secretName) =>
        Effect.fn("Fly.GetSecret")(function* () {
          return yield* auth.authorize(
            machines.secretGet({
              app_name: yield* appName,
              secret_name: yield* secretName,
              // Fly only returns plaintext from a Machine in the same App.
              show_secrets: globalThis.__ALCHEMY_RUNTIME__ === true,
            }),
          );
        }),
    }),
  ),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(CredentialsFromEnv));
