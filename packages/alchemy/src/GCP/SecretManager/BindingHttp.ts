import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { LocationsSecret } from "./LocationsSecret.ts";
import type { Secret } from "./Secret.ts";

export type SecretBindingTarget = Secret | LocationsSecret;

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  Credentials | HttpClient.HttpClient
> &
  ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);

/**
 * Shared HTTP scaffolding for Secret Manager bindings.
 * NOT exported from index.ts.
 */
export const makeSecretHttpBinding = <I, A, E, Req = void>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
  toInput: (secretName: string, request: Req | undefined) => I;
}) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    const run = yield* options.operation.pipe(
      Effect.provideService(Credentials, credentials),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return Effect.fn(function* (secret: SecretBindingTarget) {
      const name = yield* secret.name;
      return Effect.fn(`${options.tag}(${secret.LogicalId})`)(function* (
        request?: Req,
      ) {
        return yield* run(options.toInput(yield* name, request));
      });
    });
  });
