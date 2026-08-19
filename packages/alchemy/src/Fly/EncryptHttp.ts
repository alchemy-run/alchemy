import { CredentialsFromEnv } from "@distilled.cloud/fly-io";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { Encrypt, type EncryptRequest } from "./Encrypt.ts";
import {
  fromByteList,
  makeHttpSecretKeyBinding,
  toByteList,
} from "./SecretKeyHttp.ts";

/**
 * HTTP implementation of {@link Encrypt}.
 *
 * @layer
 * @provides Fly.Encrypt
 */
export const EncryptHttp = Layer.effect(
  Encrypt,
  Effect.suspend(() =>
    makeHttpSecretKeyBinding({
      makeClient: (auth, appName, secretName) =>
        Effect.fn("Fly.Encrypt")(function* (request: EncryptRequest) {
          const res = yield* auth.authorize(
            machines.secretkeyEncrypt({
              app_name: yield* appName,
              secret_name: yield* secretName,
              plaintext: toByteList(request.plaintext),
              associated_data:
                request.associatedData === undefined
                  ? undefined
                  : toByteList(request.associatedData),
            }),
          );
          return { ciphertext: fromByteList(res.ciphertext) };
        }),
    }),
  ),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(CredentialsFromEnv));
