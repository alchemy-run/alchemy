/**
 * Unit coverage for the `alchemy/serve` runtime bridge (pure-local, no
 * cloud):
 *   - env resolution ladder (explicit → getCloudflareContext global →
 *     process.env)
 *   - `server.routes` glob matching (inclusions, `!` exclusions)
 *   - the four-worlds guard: no `ALCHEMY_STACK_NAME` markers → `match`
 *     declines without building layers
 *   - the passthrough protocol: `RouteNotFound` (and `Serve.passthrough`)
 *     resolve `undefined`; a handler that chose 404 returns a real 404
 *   - sentinel literal presence in the bridge module source
 *   - `makeWebsiteExports` fetch dispatch: routes → effect fetch,
 *     passthrough/miss → framework fallback
 *
 * The runtime tests stamp `globalThis.__ALCHEMY_RUNTIME__` (as any real
 * bridge construction does), which is process-global state — they take the
 * runner's whole-process write lock via `{ exclusive: true }` and restore
 * the flag in `finally`. The bridge modules that stamp at module evaluation
 * (`@/Serve/worker.ts`) are imported dynamically inside those tests for the
 * same reason.
 */
import * as Cloudflare from "@/Cloudflare/index.ts";
import { SERVE_SENTINEL } from "@/Serve/constants.ts";
import {
  cloudflareContextSymbol,
  hasStackMarkers,
  resolveServeEnv,
} from "@/Serve/Env.ts";
import { passthrough } from "@/Serve/Passthrough.ts";
import { matchRoutes } from "@/Serve/Routes.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { RouteNotFound } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const markers = {
  ALCHEMY_STACK_NAME: "serve-test",
  ALCHEMY_STAGE: "test",
};

class TestSite extends Cloudflare.Website.Vite<TestSite>()(
  "ServeTestSite",
  { main: import.meta.url },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/api/hello")) {
          return HttpServerResponse.text("hi");
        }
        if (request.url.startsWith("/api/pass")) {
          return yield* passthrough;
        }
        if (request.url.startsWith("/api/gone")) {
          // A handler that matched and chose 404: must stay a real 404,
          // never be sniffed into passthrough.
          return HttpServerResponse.text("really gone", { status: 404 });
        }
        return yield* Effect.fail(new RouteNotFound({ request }));
      }),
    };
  }),
) {}

/** Run `body` with the runtime flag restored afterwards (exclusive tests). */
const restoringRuntimeFlag = async (body: () => Promise<void>) => {
  const previous = globalThis.__ALCHEMY_RUNTIME__;
  try {
    await body();
  } finally {
    globalThis.__ALCHEMY_RUNTIME__ = previous;
  }
};

describe("env resolution ladder", () => {
  it("explicit env wins over everything", async () => {
    const explicit = { ALCHEMY_STACK_NAME: "explicit" };
    expect(await resolveServeEnv(explicit)).toBe(explicit);
  });

  it(
    "falls back to the getCloudflareContext-shaped global",
    async () => {
      const holder = globalThis as Record<PropertyKey, any>;
      const previous = holder[cloudflareContextSymbol];
      holder[cloudflareContextSymbol] = {
        env: { ALCHEMY_STACK_NAME: "from-global" },
      };
      try {
        const env = await resolveServeEnv();
        expect(env?.ALCHEMY_STACK_NAME).toBe("from-global");
      } finally {
        if (previous === undefined) {
          delete holder[cloudflareContextSymbol];
        } else {
          holder[cloudflareContextSymbol] = previous;
        }
      }
    },
    { exclusive: true },
  );

  it(
    "falls back to process.env when no platform env exists",
    async () => {
      const env = await resolveServeEnv();
      expect(env).toBe(process.env);
    },
    { exclusive: true },
  );

  it("hasStackMarkers requires ALCHEMY_STACK_NAME", () => {
    expect(hasStackMarkers(undefined)).toBe(false);
    expect(hasStackMarkers({})).toBe(false);
    expect(hasStackMarkers({ ALCHEMY_STACK_NAME: "" })).toBe(false);
    expect(hasStackMarkers({ OTHER: "x" })).toBe(false);
    expect(hasStackMarkers(markers)).toBe(true);
  });
});

describe("route matching", () => {
  it("matches path globs", () => {
    expect(matchRoutes(["/api/*"], "/api/users")).toBe(true);
    expect(matchRoutes(["/api/*"], "/api/users/1/posts")).toBe(true);
    expect(matchRoutes(["/api/*"], "/api")).toBe(false);
    expect(matchRoutes(["/api/*"], "/assets/app.js")).toBe(false);
    expect(matchRoutes(["/*"], "/anything/at/all")).toBe(true);
    expect(matchRoutes(["/api/*", "/rpc/*"], "/rpc/call")).toBe(true);
  });

  it("exclusions take precedence over inclusions", () => {
    const routes = ["/api/*", "!/api/public/*"];
    expect(matchRoutes(routes, "/api/users")).toBe(true);
    expect(matchRoutes(routes, "/api/public/logo.png")).toBe(false);
  });

  it("escapes regex metacharacters in globs", () => {
    expect(matchRoutes(["/api/v1.0/*"], "/api/v1.0/x")).toBe(true);
    expect(matchRoutes(["/api/v1.0/*"], "/api/v1x0/x")).toBe(false);
  });
});

describe("sentinel", () => {
  it.effect("embeds the literal in the bridge module source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const source = yield* fs.readFileString(
        new URL("../../src/Serve/Bridge.ts", import.meta.url).pathname,
      );
      expect(source).toContain(SERVE_SENTINEL);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Serve.make", () => {
  it(
    "declines without alchemy env markers (four-worlds guard)",
    () =>
      restoringRuntimeFlag(async () => {
        const { make } = await import("@/Serve/index.ts");
        // A fake class proves no layer build is attempted on decline.
        class NeverBuilt {
          static readonly LogicalId = "NeverBuilt";
        }
        const handle = make(NeverBuilt as any);
        const declined = await handle.match(
          new Request("http://localhost/api/hello"),
          { env: { NOT_ALCHEMY: "1" } },
        );
        expect(declined).toBeUndefined();
        expect(
          await handle.match(new Request("http://localhost/api/hello"), {
            env: {},
          }),
        ).toBeUndefined();
      }),
    { exclusive: true },
  );

  it(
    "serves matched requests and maps RouteNotFound to passthrough",
    () =>
      restoringRuntimeFlag(async () => {
        const { make } = await import("@/Serve/index.ts");
        const handle = make(TestSite);

        const hit = await handle.match(
          new Request("http://localhost/api/hello"),
          { env: markers },
        );
        expect(hit?.status).toBe(200);
        expect(await hit!.text()).toBe("hi");

        // RouteNotFound (the HttpRouter miss) delegates.
        const miss = await handle.match(
          new Request("http://localhost/api/unknown"),
          { env: markers },
        );
        expect(miss).toBeUndefined();

        // Explicit Serve.passthrough delegates.
        const passed = await handle.match(
          new Request("http://localhost/api/pass"),
          { env: markers },
        );
        expect(passed).toBeUndefined();

        // A handler that matched and chose 404 returns a REAL 404 — no
        // 404-sniffing.
        const gone = await handle.match(
          new Request("http://localhost/api/gone"),
          { env: markers },
        );
        expect(gone?.status).toBe(404);
        expect(await gone!.text()).toBe("really gone");
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "fetch answers declined requests via fallback or 404",
    () =>
      restoringRuntimeFlag(async () => {
        const { make } = await import("@/Serve/index.ts");
        const handle = make(TestSite);

        const fromFallback = await handle.fetch(
          new Request("http://localhost/api/pass"),
          {
            env: markers,
            fallback: async () => new Response("framework", { status: 200 }),
          },
        );
        expect(await fromFallback.text()).toBe("framework");

        const notFound = await handle.fetch(
          new Request("http://localhost/api/pass"),
          { env: markers },
        );
        expect(notFound.status).toBe(404);
      }),
    { exclusive: true, timeout: 60_000 },
  );
});

describe("makeWebsiteExports", () => {
  it(
    "dispatches routes to the effect fetch and falls through to the framework",
    () =>
      restoringRuntimeFlag(async () => {
        const { makeWebsiteExports } = await import("@/Serve/worker.ts");

        class StubEntrypoint {
          constructor(
            public ctx: any,
            public env: any,
          ) {}
        }
        const WebsiteWorker = makeWebsiteExports(StubEntrypoint, {
          site: TestSite,
          routes: ["/api/*"],
          framework: async () => ({
            default: {
              fetch: async () => new Response("framework"),
            },
          }),
        });

        const ctx = {
          waitUntil: (_promise: Promise<unknown>) => {},
          passThroughOnException: () => {},
        };
        const worker: any = new WebsiteWorker(ctx, markers);

        // Inside routes → effect fetch.
        const hit: Response = await worker.fetch(
          new Request("http://localhost/api/hello"),
        );
        expect(await hit.text()).toBe("hi");

        // Outside routes → framework, without touching the effect fetch.
        const outside: Response = await worker.fetch(
          new Request("http://localhost/assets/app.js"),
        );
        expect(await outside.text()).toBe("framework");

        // Inside routes but passthrough → framework fallback.
        const passed: Response = await worker.fetch(
          new Request("http://localhost/api/pass"),
        );
        expect(await passed.text()).toBe("framework");

        // No env markers (prerender world) → framework, no layer build.
        const guarded: any = new WebsiteWorker(ctx, {});
        const declined: Response = await guarded.fetch(
          new Request("http://localhost/api/hello"),
        );
        expect(await declined.text()).toBe("framework");
      }),
    { exclusive: true, timeout: 60_000 },
  );
});

describe("Serve.exports", () => {
  it(
    "throws the typed phase-3 stub error",
    () =>
      restoringRuntimeFlag(async () => {
        const Serve = await import("@/Serve/index.ts");
        try {
          Serve.exports(TestSite);
          throw new Error("expected Serve.exports to throw");
        } catch (error: any) {
          expect(error._tag).toBe("ServeExportsUnavailableError");
          expect(error.message).toContain("Serve.exports");
        }
      }),
    { exclusive: true },
  );
});
