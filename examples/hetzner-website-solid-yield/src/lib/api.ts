import * as Effect from "effect/Effect";
import { Failure } from "solid-yield";
import { Api } from "./runtime.ts";

/** The API call failed: a typed failure the view's `Errored` boundary handles. */
export class ApiError extends Failure("api-error") {}

/** `GET /api/greeting` through the `Api` client the runtime provides. */
export const getGreeting = Effect.gen(function* () {
  const api = yield* Api;
  return yield* api.Greeting.greeting();
}).pipe(Effect.mapError((error) => new ApiError(error.message)));
