import { CredentialsFromEnv } from "@distilled.cloud/fly-io";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { makeHttpSecretKeyBinding, toByteList } from "./SecretKeyHttp.ts";
import { Verify, type VerifyRequest } from "./Verify.ts";

/**
 * HTTP implementation of {@link Verify}. Provide it on the
 * {@link Service} or Action Effect.
 *
 * @layer
 * @provides Fly.Verify
 *
 * @section Provide the layer
 * @example On a Service
 * ```typescript
 * Effect.gen(function* () {
 *   const verify = yield* Fly.Verify(Signing);
 *   // ...
 * }).pipe(Effect.provide(Fly.VerifyHttp))
 * ```
 */
export const VerifyHttp = Layer.effect(
  Verify,
  Effect.suspend(() =>
    makeHttpSecretKeyBinding({
      makeClient: (auth, appName, secretName) =>
        Effect.fn("Fly.Verify")(function* (request: VerifyRequest) {
          yield* auth.authorize(
            machines.secretkeyVerify({
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
