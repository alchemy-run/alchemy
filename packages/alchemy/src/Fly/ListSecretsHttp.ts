import { CredentialsFromEnv } from "@distilled.cloud/fly-io";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { ListSecrets } from "./ListSecrets.ts";
import { makeHttpAppBinding } from "./SecretHttp.ts";

/**
 * HTTP implementation of {@link ListSecrets}.
 *
 * @layer
 * @provides Fly.ListSecrets
 */
export const ListSecretsHttp = Layer.effect(
  ListSecrets,
  Effect.suspend(() =>
    makeHttpAppBinding({
      makeClient: (auth, appName) =>
        Effect.fn("Fly.ListSecrets")(function* () {
          return yield* auth.authorize(
            machines.secretsList({
              app_name: yield* appName,
              show_secrets: globalThis.__ALCHEMY_RUNTIME__ === true,
            }),
          );
        }),
    }),
  ),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(CredentialsFromEnv));
