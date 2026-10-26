import * as Azure from "@alchemy.run/azure";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { makeEntraRedis } from "./EntraRedis.ts";
import { Counters } from "./resources.ts";

/** Hits allowed per key per window. */
export const LIMIT = 5;

/** Length of a fixed window, in seconds. */
export const WINDOW_SECONDS = 60;

const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const redisKey = (key: string) => `ratelimit:${key}`;

const asNumber = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * A fixed-window rate limiter on Azure Functions (Flex Consumption),
 * counting in Azure Managed Redis.
 *
 * - `POST /hit/:key` — count one hit against `key`. `200` while the key is
 *   within {@link LIMIT} hits per {@link WINDOW_SECONDS}, `429` (with
 *   `retry-after`) once it is over.
 * - `GET /count/:key` — the current count and seconds until the window
 *   resets, without counting a hit.
 *
 * The app signs in to Redis as its system-assigned managed identity with a
 * Microsoft Entra ID token. The stack grants that identity the database's
 * `default` access policy (`Azure.Redis.AccessPolicyAssignment` in
 * `alchemy.run.ts`). No access key reaches the app.
 *
 * A Redis or token error answers `503` with the error, so a caller can
 * retry while the access policy assignment takes effect after a deploy.
 */
export default class Api extends Azure.Functions.Function<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const counters = yield* Counters;
    // Read from the app's settings at runtime.
    const hostName = yield* counters.hostName;
    const port = yield* counters.port;

    const redis = makeEntraRedis(
      Effect.gen(function* () {
        const host = yield* hostName;
        const tcpPort = yield* port;
        return { host, port: tcpPort };
      }),
    );

    /**
     * One round trip: start the window if the key is new (`SET NX EX`
     * sets the TTL only on creation), count the hit (`INCR` keeps the
     * TTL), and read the time left in the window.
     */
    const hit = (key: string) =>
      redis
        .pipeline([
          ["SET", redisKey(key), "0", "EX", WINDOW_SECONDS, "NX"],
          ["INCR", redisKey(key)],
          ["TTL", redisKey(key)],
        ])
        .pipe(Effect.map(([, count, ttl]) => ({ count: asNumber(count), ttl: asNumber(ttl) })));

    const peek = (key: string) =>
      redis
        .pipeline([
          ["GET", redisKey(key)],
          ["TTL", redisKey(key)],
        ])
        .pipe(Effect.map(([count, ttl]) => ({ count: asNumber(count ?? 0), ttl: asNumber(ttl) })));

    const body = (key: string, count: number, ttl: number) => ({
      key,
      count,
      limit: LIMIT,
      remaining: Math.max(0, LIMIT - count),
      limited: count > LIMIT,
      // TTL is -2 for a missing key; there is no window to reset.
      resetInSeconds: ttl >= 0 ? ttl : null,
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const [route, key, ...rest] = url.pathname.split("/").filter(Boolean);

        if (request.method === "GET" && route === undefined) {
          return HttpServerResponse.text("ok");
        }

        if (key === undefined || rest.length > 0 || !KEY_PATTERN.test(key)) {
          return yield* HttpServerResponse.json({ error: "not found" }, { status: 404 });
        }

        if (request.method === "POST" && route === "hit") {
          const { count, ttl } = yield* hit(key);
          const result = body(key, count, ttl);
          return yield* HttpServerResponse.json(result, {
            status: result.limited ? 429 : 200,
            headers: result.limited ? { "retry-after": String(Math.max(ttl, 1)) } : {},
          });
        }

        if (request.method === "GET" && route === "count") {
          const { count, ttl } = yield* peek(key);
          return yield* HttpServerResponse.json(body(key, count, ttl));
        }

        return yield* HttpServerResponse.json({ error: "not found" }, { status: 404 });
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: Cause.pretty(cause) }, { status: 503 }),
        ),
      ),
    };
  }),
) {}
