import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { CustomClasse } from "./CustomClasse.ts";
import type { PhraseSet } from "./PhraseSet.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  Credentials | HttpClient.HttpClient
> &
  ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);

const makeNamedHttpBinding = <
  Resource extends CustomClasse | PhraseSet,
  I,
  A,
  E,
  Req = void,
>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
  toInput: (name: string, request: Req | undefined) => I;
}) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    const run = yield* options.operation.pipe(
      Effect.provideService(Credentials, credentials),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return Effect.fn(function* (resource: Resource) {
      const name = yield* resource.name;
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (
        request?: Req,
      ) {
        const resourceName = yield* name;
        return yield* run(options.toInput(resourceName, request));
      });
    });
  });

/**
 * Shared HTTP scaffolding for Speech-to-Text bindings.
 * NOT exported from index.ts.
 */
export const makeCustomClassHttpBinding = <I, A, E, Req = void>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
  toInput: (name: string, request: Req | undefined) => I;
}) => makeNamedHttpBinding<CustomClasse, I, A, E, Req>(options);

export const makePhraseSetHttpBinding = <I, A, E, Req = void>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
  toInput: (name: string, request: Req | undefined) => I;
}) => makeNamedHttpBinding<PhraseSet, I, A, E, Req>(options);
