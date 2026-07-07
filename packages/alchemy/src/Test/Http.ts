import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";

/**
 * A freshly-deployed Cloudflare Worker is not instantly reachable over HTTP.
 * Its `workers.dev` route, the script, and each binding (R2 / D1 / DO / Secrets
 * Store) propagate to the edge independently and asynchronously, so the first
 * requests to a new URL can transiently return:
 *
 *  - `404` while the `workers.dev` subdomain / route is still propagating
 *    (Cloudflare serves its "There is nothing here yet" placeholder), or
 *  - `5xx` while the script is up but a binding it depends on isn't ready yet.
 *
 * This is ordinary eventual consistency that belongs at the call site, not in
 * the resource provider — the provider returning before every edge PoP has
 * converged is correct. Consumers ride out the window by retrying the request.
 */
export class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

/**
 * Status codes that indicate the edge hasn't finished converging on a fresh
 * deploy. Deliberate client errors (`401`, `403`, `400`, …) are NOT in this
 * set, so assertions on those statuses still observe them immediately rather
 * than being retried away.
 */
const isColdStartStatus = (status: number): boolean =>
  status === 404 || status >= 500;

export interface WhenReadyOptions {
  /** Max retry attempts before surfacing {@link WorkerNotReady}. Default `20`. */
  times?: number;
}

/**
 * Execute an arbitrary {@link HttpClientRequest.HttpClientRequest}, retrying
 * through the Cloudflare cold-start window ({@link isColdStartStatus}) until the
 * Worker serves a non-transient response. The returned response can carry any
 * non-cold-start status (e.g. `200`, `202`, `401`) for the caller to assert on.
 */
export const executeWhenReady = (
  request: HttpClientRequest.HttpClientRequest,
  options?: WhenReadyOptions,
): Effect.Effect<HttpClientResponse, unknown, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.execute(request).pipe(
      Effect.flatMap((response) =>
        isColdStartStatus(response.status)
          ? Effect.fail(new WorkerNotReady({ status: response.status }))
          : Effect.succeed(response),
      ),
      Effect.retry({
        while: (error) => error instanceof WorkerNotReady,
        schedule: Schedule.exponential("500 millis").pipe(
          Schedule.both(Schedule.recurs(options?.times ?? 20)),
        ),
      }),
    );
  });

/**
 * Convenience wrapper over {@link executeWhenReady} for a plain `GET`.
 */
export const getWhenReady = (
  url: string,
  options?: WhenReadyOptions,
): Effect.Effect<HttpClientResponse, unknown, HttpClient.HttpClient> =>
  executeWhenReady(HttpClientRequest.get(url), options);
