import { CredentialsFromEnv } from "@distilled.cloud/fly-io";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  bytesToBase64,
  flyKmsPost,
  makeHttpSecretKeyBinding,
  toByteList,
} from "./SecretKeyHttp.ts";
import { Verify, type VerifyRequest } from "./Verify.ts";

/**
 * HTTP implementation of {@link Verify}. Provide it on the
 * {@link Service} or Action Effect.
 *
 *
 * ### Provide the layer
 * **Example:** On a Service
 * ```typescript
 * Effect.gen(function* () {
 *   const verify = yield* Fly.Verify(Signing);
 *   // ...
 * }).pipe(Effect.provide(Fly.VerifyHttp))
 * ```
 *
 * @layer
 * @provides Fly.Verify
 */
export const VerifyHttp = Layer.effect(
  Verify,
  Effect.suspend(() =>
    makeHttpSecretKeyBinding({
      makeClient: (auth, appName, secretName) =>
        Effect.fn("Fly.Verify")(function* (request: VerifyRequest) {
          if (globalThis.__ALCHEMY_RUNTIME__) {
            const res = yield* flyKmsPost(
              yield* appName,
              yield* secretName,
              "verify",
              {
                plaintext: bytesToBase64(request.plaintext),
                signature: bytesToBase64(request.signature),
              },
            );
            return { valid: res.valid === true || res.valid === undefined };
          }
          yield* auth.authorize(
            machines.verifySecretKey({
              app_name: yield* appName,
              secret_name: yield* secretName,
              plaintext: toByteList(request.plaintext),
              signature: toByteList(request.signature),
            }),
          );
          return { valid: true as const };
        }),
    }),
  ),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(CredentialsFromEnv));
