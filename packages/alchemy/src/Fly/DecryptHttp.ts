import { CredentialsFromEnv } from "@distilled.cloud/fly-io";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { Decrypt, type DecryptRequest } from "./Decrypt.ts";
import {
  fromByteList,
  makeHttpSecretKeyBinding,
  toByteList,
} from "./SecretKeyHttp.ts";

/** Runtime layer for {@link Decrypt}. */
export const DecryptHttp = Layer.effect(
  Decrypt,
  Effect.suspend(() =>
    makeHttpSecretKeyBinding({
      makeClient: (auth, appName, secretName) =>
        Effect.fn("Fly.Decrypt")(function* (request: DecryptRequest) {
          const res = yield* auth.authorize(
            machines.secretkeyDecrypt({
              app_name: yield* appName,
              secret_name: yield* secretName,
              ciphertext: toByteList(request.ciphertext),
              associated_data:
                request.associatedData === undefined
                  ? undefined
                  : toByteList(request.associatedData),
            }),
          );
          return {
            plaintext: Redacted.make(fromByteList(res.plaintext)),
          };
        }),
    }),
  ),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(CredentialsFromEnv));
