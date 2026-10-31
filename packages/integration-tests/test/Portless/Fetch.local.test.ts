import { lookup } from "node:dns/promises";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../Cloudflare/Utils/Fixture.ts";
import { Api } from "./fixtures/fetch/api.ts";
import EffectCaller from "./fixtures/fetch/effect-caller.ts";
import * as TestProxy from "./fixtures/TestProxy.ts";

// A local Worker reaches a Portless service over HTTPS and verifies the certificate: the proxy's
// CA is published as `alchemy dev` does, and workerd reads it. In-process, because workerd and the
// Vite child take their environment from the process that starts them, and the shared sidecar's
// is fixed when it spawns (see DevTrust.local.test.ts).
const proxy = TestProxy.make({}, { trust: true });
const { test, afterAll } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), proxy.providers()),
  dev: true,
  stage: "dev_alice",
  sidecar: false,
});
afterAll(proxy.stop);

// workerd and the Vite child resolve the service's `.localhost` name with the system resolver,
// which not every Linux setup points at loopback.
const resolvesLocalhost = await lookup("alchemy-portless-test.localhost").then(
  ({ address }) => address === "127.0.0.1" || address === "::1",
  () => false,
);

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class NotReady extends Data.TaggedError("NotReady")<{ status: number; body: string }> {}

/** GETs a Worker, retrying until the freshly started workerd serves a 200. */
const getReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? Effect.succeed(response)
          : response.text.pipe(
              Effect.flatMap((body) =>
                Effect.fail(new NotReady({ status: response.status, body })),
              ),
            ),
      ),
      Effect.retry({
        while: (error): error is NotReady => error instanceof NotReady,
        schedule: Schedule.max([
          Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("2 seconds")]),
          Schedule.recurs(15),
        ]),
      }),
    );
    return (yield* response.json) as Record<string, unknown>;
  }).pipe(Effect.orDie);

/** What the Api dev server reports about the request that reached it through the proxy. */
const expectServedBy = (body: Record<string, unknown>, origin: string) =>
  Effect.gen(function* () {
    const port = yield* proxy.port;
    const host = new URL(origin).hostname;
    expect(body).toMatchObject({
      name: "api",
      host: "127.0.0.1",
      portlessUrl: origin,
      requestHost: `${host}:${port}`,
    });
  });

const options = {
  tags: ["provider:cloudflare:worker", "local"],
  timeout: 180_000,
  exclusive: true,
};

test.provider.skipIf(!resolvesLocalhost)(
  "an Effect-native Worker calls a Dev service through Portless.Fetch, verifying the certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* Api;
          const caller = yield* EffectCaller;
          return { api, caller };
        }),
      );
      expect(deployed.caller.url).toMatch(/^http:\/\/localhost:\d+$/);
      // The relative URL "/hello" resolved against the origin the Dev resolved to.
      yield* expectServedBy(yield* getReady(`${deployed.caller.url}/`), deployed.api.origin);
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(!resolvesLocalhost)(
  "a plain Worker calls a Dev service with fetch and an env origin, verifying the certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* Api;
          const caller = yield* Cloudflare.Worker("PortlessAsyncCaller", {
            main: pathe.resolve(import.meta.dirname, "fixtures/fetch/async-caller.ts"),
            env: { API_URL: api.origin },
          });
          return { api, caller };
        }),
      );
      yield* expectServedBy(yield* getReady(`${deployed.caller.url}/`), deployed.api.origin);
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(!resolvesLocalhost)(
  "a Vite-hosted Worker calls a Dev service with fetch and an env origin, verifying the certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const rootDir = yield* cloneFixture(
        pathe.resolve(import.meta.dirname, "fixtures/fetch/vite"),
        {
          prefix: "alchemy-portless-fetch-vite-",
          // Under the workspace, as the other Vite fixtures (see Vite.test.ts).
          tempRoot: pathe.resolve(import.meta.dirname, "../../.tmp"),
          entries: ["package.json", "vite.config.ts", "src"],
        },
      );
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* Api;
          const site = yield* Cloudflare.Website.Vite("PortlessVite", {
            rootDir,
            main: "./src/index.ts",
            workersDev: true,
            compatibility: { date: "2024-12-30" },
            memo: { include: ["**/*"] },
            dev: { port: 0 },
            env: { API_URL: api.origin },
          });
          return { api, site };
        }),
      );
      yield* expectServedBy(
        yield* getReady(deployed.site.url!.replace(/\/$/, "")),
        deployed.api.origin,
      );
      yield* stack.destroy();
    }).pipe(Effect.scoped, logLevel),
  options,
);
