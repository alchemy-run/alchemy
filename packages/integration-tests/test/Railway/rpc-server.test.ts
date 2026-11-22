import { bindFunction } from "@alchemy.run/railway/Bind";
import { serveRailwayRpc } from "@alchemy.run/railway/rpc-server";
import { RPC_PATH_PREFIX, RPC_TOKEN_ENV, RPC_TOKEN_HEADER } from "@alchemy.run/railway/rpc-token";
import { describe, expect, it } from "@alchemy.run/test";
import { safeHttpEffect } from "alchemy/Http";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

const TOKEN = "a".repeat(64);
const PRIVATE_URL = "http://greeter.railway.internal:3000";
const PUBLIC_URL = "https://greeter.up.railway.app";

const shape = { greet: (name: string) => Effect.succeed(`hello ${name}`) };

const fallback = Effect.succeed(HttpServerResponse.text("ok"));

// The host's token as `serveRailwayRpc` reads it, through `Config`. Effect's
// default provider snapshots `process.env` on first use, so setting the env var
// inside a test never reaches it.
const webHandler = HttpEffect.toWebHandler(
  safeHttpEffect(
    serveRailwayRpc(shape, fallback).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: { [RPC_TOKEN_ENV]: TOKEN } }),
      ),
    ),
  ),
);

const fetchImpl = ((url: any, init?: any) => {
  const href = typeof url === "string" ? url : String(url);
  const parsed = new URL(href);
  const headers = new Headers(init?.headers);
  headers.set("host", parsed.host);
  return webHandler(new Request(href, { ...init, headers }));
}) as typeof globalThis.fetch;

const rpcPost = (url: string, headers: Record<string, string> = {}) =>
  webHandler(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(["sam"]),
    }),
  );

/** POST `greet("sam")` to `url` with `headers`; answers the response. */
const greet = (url: string, headers: Record<string, string>) =>
  Effect.promise(() => rpcPost(`${url}${RPC_PATH_PREFIX}greet`, headers));

const PRIVATE_HOST = "greeter.railway.internal:3000";

describe.sequential(
  "Railway private-mesh RPC",
  { tags: ["unit", "provider:railway", "local"] },
  () => {
    it.effect("serves value methods on the private mesh with the token", () =>
      Effect.gen(function* () {
        const response = yield* greet(PRIVATE_URL, {
          host: PRIVATE_HOST,
          [RPC_TOKEN_HEADER]: TOKEN,
        });
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.text())).toBe(JSON.stringify("hello sam"));
      }),
    );

    it.effect("401s public Host even with the token", () =>
      Effect.gen(function* () {
        const response = yield* greet(PUBLIC_URL, {
          host: "greeter.up.railway.app",
          [RPC_TOKEN_HEADER]: TOKEN,
        });
        expect(response.status).toBe(401);
      }),
    );

    it.effect("401s the private mesh without a token", () =>
      Effect.gen(function* () {
        const response = yield* greet(PRIVATE_URL, { host: PRIVATE_HOST });
        expect(response.status).toBe(401);
      }),
    );

    it.effect("401s a wrong token", () =>
      Effect.gen(function* () {
        const response = yield* greet(PRIVATE_URL, {
          host: PRIVATE_HOST,
          [RPC_TOKEN_HEADER]: "b".repeat(64),
        });
        expect(response.status).toBe(401);
      }),
    );

    it.effect("401s when X-Forwarded-Host is a public domain", () =>
      Effect.gen(function* () {
        const response = yield* greet(PRIVATE_URL, {
          host: PRIVATE_HOST,
          "x-forwarded-host": "greeter.up.railway.app",
          [RPC_TOKEN_HEADER]: TOKEN,
        });
        expect(response.status).toBe(401);
      }),
    );

    it.effect("falls through to fetch outside /__rpc__/", () =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() => webHandler(new Request(`${PUBLIC_URL}/`)));
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.text())).toBe("ok");
      }),
    );

    it.effect(
      "bindFunction stub round-trips through the private mesh",
      () =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const previousFetch = globalThis.fetch;
            globalThis.__ALCHEMY_RUNTIME__ = true;
            globalThis.fetch = fetchImpl;
            process.env.RAILWAY_RPC_GREETER_HOST = "greeter.railway.internal";
            process.env.RAILWAY_RPC_GREETER_PORT = "3000";
            process.env.RAILWAY_RPC_GREETER_TOKEN = TOKEN;
            return previousFetch;
          }),
          (previousFetch) =>
            Effect.sync(() => {
              globalThis.fetch = previousFetch;
              globalThis.__ALCHEMY_RUNTIME__ = false;
              delete process.env.RAILWAY_RPC_GREETER_HOST;
              delete process.env.RAILWAY_RPC_GREETER_PORT;
              delete process.env.RAILWAY_RPC_GREETER_TOKEN;
            }),
        ).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const stub = yield* bindFunction<{
                greet: (name: string) => Effect.Effect<string>;
              }>({ Type: "Railway.Function", LogicalId: "Greeter" } as never);
              expect(yield* stub.greet("sam")).toBe("hello sam");
            }),
          ),
        ),
      { tags: ["provider:railway:bind"], exclusive: true },
    );
  },
);
