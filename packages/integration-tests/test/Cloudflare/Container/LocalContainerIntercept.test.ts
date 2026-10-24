import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { INTERCEPT_HOST } from "./fixtures/intercept/object.ts";
import InterceptStack, { state } from "./fixtures/intercept/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state,
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// First request has to wait for the local runtime to `docker build` the image
// and boot the container, so give it plenty of room.
const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 240_000;

const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

/**
 * `interceptOutboundHttp` / `interceptAllOutboundHttp` on a container
 * handle must register the caller's Fetcher with workerd, so the container's
 * outbound HTTP reaches the Durable Object that owns it.
 */
describe(
  "local container outbound interception",
  { tags: ["provider:cloudflare", "provider:cloudflare:container", "provider:cloudflare:worker"] },
  () => {
    const stack = beforeAll(deploy(InterceptStack), { timeout: HOOK_TIMEOUT });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(InterceptStack), { timeout: HOOK_TIMEOUT });

    const probe = (path: string) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        const client = yield* HttpClient.HttpClient;
        const text = yield* client.get(new URL(path, url)).pipe(
          Effect.flatMap((r) =>
            r.status !== 200 ? Effect.fail(new Error(`not ready: ${r.status}`)) : r.text,
          ),
          Effect.timeout("30 seconds"),
          Effect.retry({ schedule: readinessSchedule, times: 30 }),
        );
        return JSON.parse(text) as { status?: number; body?: string; error?: string };
      });

    test(
      "interceptOutboundHttp routes the container's requests for a host to the object",
      Effect.gen(function* () {
        const result = yield* probe("/probe/host");
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(200);
        expect(result.body).toBe(`intercepted ${INTERCEPT_HOST}/hello`);
      }).pipe(logLevel),
      { tags: ["local"], timeout: TEST_TIMEOUT },
    );

    test(
      "interceptAllOutboundHttp routes all of the container's requests to the object",
      Effect.gen(function* () {
        const result = yield* probe("/probe/all");
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(200);
        expect(result.body).toBe("intercepted any.example/hello");
      }).pipe(logLevel),
      { tags: ["local"], timeout: TEST_TIMEOUT },
    );

    test(
      "interceptOutboundHttp can route to the Worker's own entrypoint",
      Effect.gen(function* () {
        const result = yield* probe("/probe/entrypoint");
        expect(result.error).toBeUndefined();
        expect(result.body).toBe(`entrypoint ${INTERCEPT_HOST}/hello`);
      }).pipe(logLevel),
      { tags: ["local"], timeout: TEST_TIMEOUT },
    );

    test(
      "an egress answers its host over HTTPS, and only while it is live",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const client = yield* HttpClient.HttpClient;
        const text = yield* client.get(new URL("/probe/egress", url)).pipe(
          Effect.flatMap((r) =>
            r.status !== 200 ? Effect.fail(new Error(`not ready: ${r.status}`)) : r.text,
          ),
          Effect.timeout("60 seconds"),
          Effect.retry({ schedule: readinessSchedule, times: 30 }),
        );
        yield* Effect.log(`egress probe: ${text}`);
        const result = JSON.parse(text) as Record<string, string>;
        const http = JSON.parse(result.http!) as { body?: string };
        const https = JSON.parse(result.https!) as { body?: string };
        const other = JSON.parse(result.other!) as { status?: number; error?: string };
        const removed = JSON.parse(result.removed!) as { status?: number; body?: string };
        // Routes are HTTPS: plain HTTP to the host isn't intercepted (and there's no internet).
        expect(http.body).not.toBe("egress GET /hello auth=-");
        expect(https.body).toBe("egress GET /hello auth=-");
        // Not an egress host: no internet, no interception.
        expect(other.status === undefined || other.status >= 400).toBe(true);
        expect(removed.status).toBe(403);
      }).pipe(logLevel),
      { tags: ["local"], timeout: TEST_TIMEOUT },
    );

    test(
      "interceptOutboundHttps injects the CA and routes TLS requests to the entrypoint",
      Effect.gen(function* () {
        const result = (yield* probe("/probe/https")) as { ca?: { exists: boolean } } & {
          status?: number;
          body?: string;
          error?: string;
        };
        yield* Effect.log(`https probe: ${JSON.stringify(result)}`);
        expect(result.ca?.exists).toBe(true);
        expect(result.error).toBeUndefined();
        expect(result.body).toBe(`entrypoint ${INTERCEPT_HOST}/hello`);
      }).pipe(logLevel),
      { tags: ["local"], timeout: TEST_TIMEOUT },
    );
  },
);
