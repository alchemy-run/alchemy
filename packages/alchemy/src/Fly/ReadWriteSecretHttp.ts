import { CredentialsFromEnv } from "@distilled.cloud/fly-io";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { Secret } from "./Secret.ts";
import { type SecretAuth, makeHttpSecretBinding } from "./SecretHttp.ts";
import {
  ReadWriteSecret,
  type ReadWriteSecretClient,
} from "./ReadWriteSecret.ts";
import { secretWriteClient } from "./WriteSecretHttp.ts";

/** Runtime layer for {@link ReadWriteSecret}. */
export const ReadWriteSecretHttp = Layer.effect(
  ReadWriteSecret,
  Effect.suspend(() =>
    makeHttpSecretBinding<Secret, ReadWriteSecretClient>({
      makeClient: secretReadWriteClient,
    }),
  ),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(CredentialsFromEnv));

/** Build the combined get + write client over an injectable auth. */
export const secretReadWriteClient = (
  auth: SecretAuth,
  appName: Effect.Effect<string>,
  secretName: Effect.Effect<string>,
): ReadWriteSecretClient => ({
  get: Effect.fn("Fly.Secret.get")(function* () {
    return yield* auth.authorize(
      machines.secretGet({
        app_name: yield* appName,
        secret_name: yield* secretName,
        show_secrets: globalThis.__ALCHEMY_RUNTIME__ === true,
      }),
    );
  }),
  ...secretWriteClient(auth, appName, secretName),
});
