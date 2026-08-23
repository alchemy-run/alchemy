import { CredentialsFromEnv } from "@distilled.cloud/fly-io";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { Decrypt, type DecryptRequest } from "./Decrypt.ts";
import {
  base64ToBytes,
  bytesToBase64,
  flyKmsPost,
  makeHttpSecretKeyBinding,
} from "./SecretKeyHttp.ts";

/**
 * HTTP implementation of {@link Decrypt}. Provide it on the
 * {@link Service} or Action Effect.
 *
 *
 * ### Provide the layer
 * **Example:** On a Service
 * ```typescript
 * Effect.gen(function* () {
 *   const decrypt = yield* Fly.Decrypt(Box);
 *   // ...
 * }).pipe(Effect.provide(Fly.DecryptHttp))
 * ```
 *
 * @layer
 * @provides Fly.Decrypt
 */
export const DecryptHttp = Layer.effect(
  Decrypt,
  Effect.suspend(() =>
    makeHttpSecretKeyBinding({
      makeClient: (auth, appName, secretName) =>
        Effect.fn("Fly.Decrypt")(function* (request: DecryptRequest) {
          if (globalThis.__ALCHEMY_RUNTIME__) {
            const res = yield* flyKmsPost(
              yield* appName,
              yield* secretName,
              "decrypt",
              {
                ciphertext: bytesToBase64(request.ciphertext),
                associated_data:
                  request.associatedData === undefined
                    ? undefined
                    : bytesToBase64(request.associatedData),
              },
            );
            return {
              plaintext: Redacted.make(
                base64ToBytes(
                  typeof res.plaintext === "string" ? res.plaintext : undefined,
                ),
              ),
            };
          }
          const res = yield* auth.authorize(
            machines.decryptSecretKey({
              app_name: yield* appName,
              secret_name: yield* secretName,
              ciphertext: bytesToBase64(request.ciphertext),
              associated_data:
                request.associatedData === undefined
                  ? undefined
                  : bytesToBase64(request.associatedData),
            }),
          );
          return {
            plaintext: Redacted.make(base64ToBytes(res.plaintext)),
          };
        }),
    }),
  ),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(CredentialsFromEnv));
