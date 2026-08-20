import { CredentialsFromEnv } from "@distilled.cloud/fly-io";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  fromByteList,
  makeHttpSecretKeyBinding,
  toByteList,
} from "./SecretKeyHttp.ts";
import { Sign, type SignRequest } from "./Sign.ts";

/**
 * HTTP implementation of {@link Sign}. Provide it on the
 * {@link Service} or Action Effect.
 *
 * @layer
 * @provides Fly.Sign
 *
 * @section Provide the layer
 * @example On a Service
 * ```typescript
 * Effect.gen(function* () {
 *   const sign = yield* Fly.Sign(Signing);
 *   // ...
 * }).pipe(Effect.provide(Fly.SignHttp))
 * ```
 */
export const SignHttp = Layer.effect(
  Sign,
  Effect.suspend(() =>
    makeHttpSecretKeyBinding({
      makeClient: (auth, appName, secretName) =>
        Effect.fn("Fly.Sign")(function* (request: SignRequest) {
          const res = yield* auth.authorize(
            machines.secretkeySign({
              app_name: yield* appName,
              secret_name: yield* secretName,
              plaintext: toByteList(request.plaintext),
            }),
          );
          return { signature: fromByteList(res.signature) };
        }),
    }),
  ),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(CredentialsFromEnv));
