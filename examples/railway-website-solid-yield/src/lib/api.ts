import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { Failure } from "solid-yield";
import { GreetingApi } from "../spec.ts";

/** The API call failed: a typed failure the view's `Errored` boundary handles. */
export class ApiError extends Failure("api-error") {}

/** Calls the backend through a client derived from the shared `GreetingApi` spec. */
export const getGreeting = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(GreetingApi, {
    baseUrl: import.meta.env.VITE_API_URL,
  });
  return yield* client.Greeting.greeting();
}).pipe(
  Effect.mapError((error) => new ApiError(error.message)),
  Effect.provide(FetchHttpClient.layer),
);
