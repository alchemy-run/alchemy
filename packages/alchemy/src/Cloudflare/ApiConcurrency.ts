import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";

/**
 * Default maximum number of concurrent in-flight requests to the
 * Cloudflare REST API (`api.cloudflare.com`).
 *
 * Cloudflare's edge intermittently rejects otherwise-valid credentials
 * with code 10000 "Authentication error" (surfaced as 401/403) when a
 * client fans out hundreds of simultaneous calls — exactly what a large
 * stack's plan/deploy (and especially an `--adopt` deploy, which `read`s
 * every resource up front) produces. The bounded retry policy in
 * `Providers.ts` rides out isolated blips, but a full unbounded fan-out
 * re-triggers the throttle faster than the backoff drains it, so the
 * "transient" error becomes persistent (see issue #1008). Queueing
 * requests client-side keeps the burst below the throttle's trigger
 * point in the first place.
 */
const DEFAULT_CLOUDFLARE_API_CONCURRENCY = 10;

const resolveConcurrency = (): number => {
  const raw = process.env.ALCHEMY_CLOUDFLARE_API_CONCURRENCY;
  if (raw === undefined || raw === "") {
    return DEFAULT_CLOUDFLARE_API_CONCURRENCY;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1
    ? parsed
    : DEFAULT_CLOUDFLARE_API_CONCURRENCY;
};

const CLOUDFLARE_API_HOSTNAME = "api.cloudflare.com";

const parseUrl = (url: string): URL | undefined => {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
};

/**
 * Wraps the ambient `HttpClient` so that requests to
 * `api.cloudflare.com` share a bounded concurrency pool
 * (default {@link DEFAULT_CLOUDFLARE_API_CONCURRENCY}, overridable with
 * the `ALCHEMY_CLOUDFLARE_API_CONCURRENCY` environment variable), and
 * so that a 401 response logs a warning naming the exact
 * `METHOD /path` that was rejected (once per distinct endpoint per
 * layer build).
 *
 * The endpoint warning exists because Cloudflare's 401 body is a bare
 * "Authentication error" with no request context: when a token is
 * valid for every `wrangler` check but lacks one permission an alchemy
 * provider needs, the final error alone cannot tell the user which
 * endpoint (and therefore which token scope) to fix.
 *
 * Requests to any other host pass through untouched — the same client
 * also serves non-API traffic (e.g. workers.dev readiness probes), and
 * throttling those would only slow tests down.
 *
 * Deliberately a module-level layer reference (not a factory) so the
 * layer MemoMap builds it once per runtime — `providers()` and the
 * Cloudflare state store both compose `CloudflareApiLive`, and both
 * must share one pool for the bound to mean anything.
 */
export const CloudflareApiHttpClient: Layer.Layer<
  HttpClient.HttpClient,
  never,
  HttpClient.HttpClient
> = Layer.effect(HttpClient.HttpClient)(
  Effect.gen(function* () {
    const base = yield* HttpClient.HttpClient;
    const concurrency = yield* Effect.sync(resolveConcurrency);
    const semaphore = Semaphore.makeUnsafe(concurrency);
    const warnedEndpoints = new Set<string>();
    return HttpClient.transform(base, (effect, request) => {
      const url = parseUrl(request.url);
      if (url === undefined || url.hostname !== CLOUDFLARE_API_HOSTNAME) {
        return effect;
      }
      return Semaphore.withPermits(
        semaphore,
        1,
      )(effect).pipe(
        Effect.tap((response) => {
          if (response.status !== 401) {
            return Effect.void;
          }
          const endpoint = `${request.method} ${url.pathname}`;
          if (warnedEndpoints.has(endpoint)) {
            return Effect.void;
          }
          warnedEndpoints.add(endpoint);
          return Effect.logWarning(
            `Cloudflare API responded 401 Unauthorized to \`${endpoint}\`. ` +
              "The request will be retried; if the deploy still fails with " +
              "`Unauthorized: Authentication error`, verify that the API " +
              "token (or OAuth session) has the permission this endpoint " +
              "requires.",
          );
        }),
      );
    });
  }),
);
