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

/** Runtime layer for {@link Sign}. */
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
