import { CredentialsFromEnv } from "@distilled.cloud/fly-io";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { Secret } from "./Secret.ts";
import { type SecretAuth, makeHttpSecretBinding } from "./SecretHttp.ts";
import { ReadSecret, type ReadSecretClient } from "./ReadSecret.ts";

/** Runtime layer for {@link ReadSecret}. */
export const ReadSecretHttp = Layer.effect(
  ReadSecret,
  Effect.suspend(() =>
    makeHttpSecretBinding<Secret, ReadSecretClient>({
      makeClient: secretReadClient,
    }),
  ),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(CredentialsFromEnv));

/** Build the read-only client over an injectable auth and App name. */
export const secretReadClient = (
  auth: SecretAuth,
  appName: Effect.Effect<string>,
  secretName: Effect.Effect<string>,
): ReadSecretClient => {
  const authorize = auth.authorize;
  return {
    get: Effect.fn("Fly.Secret.get")(function* (name) {
      return yield* authorize(
        machines.secretGet({
          app_name: yield* appName,
          secret_name: name ?? (yield* secretName),
          // Fly only returns plaintext from a Machine in the same App.
          show_secrets: globalThis.__ALCHEMY_RUNTIME__ === true,
        }),
      );
    }),
    list: Effect.fn("Fly.Secret.list")(function* () {
      return yield* authorize(
        machines.secretsList({
          app_name: yield* appName,
          show_secrets: globalThis.__ALCHEMY_RUNTIME__ === true,
        }),
      );
    }),
  };
};
