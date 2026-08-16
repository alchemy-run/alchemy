/**
 * Unit coverage for the `alchemy/Serve` runtime bridge (pure-local, no
 * cloud):
 *   - env resolution ladder (explicit → getCloudflareContext global →
 *     process.env)
 *   - `server.routes` glob matching (inclusions, `!` exclusions)
 *   - the four-worlds guard: no `ALCHEMY_STACK_NAME` markers → `match`
 *     declines without building layers
 *   - strict route ownership: `match` resolves `undefined` ONLY for paths
 *     outside the routes claim; inside it the effect fetch is
 *     authoritative — a `RouteNotFound` failure renders as the effect's
 *     own 404 response, and a handler that chose 404 returns that 404
 *   - sentinel literal presence in the bridge module source
 *   - `makeWebsiteExports` fetch dispatch: inside routes → effect fetch
 *     (final), outside routes / exclusion globs → framework
 *   - the trusted-transport helpers (`rpcMethodsOf`, `encodeRpcFailure`)
 *     that back the value-form `createClient` in-process dispatch and the
 *     workerd JS-RPC bridge — there is no public HTTP RPC wire
 *
 * The runtime tests stamp `globalThis.__ALCHEMY_RUNTIME__` (as any real
 * bridge construction does), which is process-global state — they take the
 * runner's whole-process write lock via `{ exclusive: true }` and restore
 * the flag in `finally`. The bridge modules that stamp at module evaluation
 * (`@/Cloudflare/Workers/ServeWorkerEntry.ts`) are imported dynamically inside those tests for the
 * same reason.
 */
import * as Cloudflare from "@/Cloudflare/index.ts";
import { SERVE_SENTINEL } from "@/Serve/constants.ts";
import {
  cloudflareContextSymbol,
  hasStackMarkers,
  resolveServeEnv,
} from "@/Serve/Env.ts";
import { matchRoutes } from "@/Serve/Routes.ts";
import { encodeRpcFailure, rpcMethodsOf } from "@/Serve/Rpc.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as Data from "effect/Data";
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
        if (request.url.startsWith("/api/gone")) {
          // A handler that matched and chose 404: stays a 404 carrying
          // this body — indistinguishable in authority from the router
          // miss below, both are the effect's own answer.
          return HttpServerResponse.text("really gone", { status: 404 });
        }
        // The HttpRouter miss: renders as the effect's own 404 response
        // through the standard pipeline — never delegation.
        return yield* Effect.fail(new RouteNotFound({ request }));
      }),
    };
  }),
) {}

class RpcTestError extends Data.TaggedError("RpcTestError")<{
  reason: string;
}> {}

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
    "declines outside the routes claim without invoking the effect fetch",
    () =>
      restoringRuntimeFlag(async () => {
        const { make } = await import("@/Serve/index.ts");
        // A fake class proves no layer build is attempted on a path miss —
        // the default claim is DEFAULT_SERVER_ROUTES (["/api/*"]).
        class NeverBuilt {
          static readonly LogicalId = "NeverBuilt";
        }
        const handle = make(NeverBuilt as any);
        expect(
          await handle.match(new Request("http://localhost/assets/app.js"), {
            env: markers,
          }),
        ).toBeUndefined();
        // No universal rpc pre-gate exists: a path outside the claim is a
        // decline no matter what it looks like.
        const narrow = make(NeverBuilt as any, { routes: ["/other/*"] });
        expect(
          await narrow.match(
            new Request("http://localhost/api/__rpc/bump", {
              method: "POST",
              body: "[1]",
            }),
            { env: markers },
          ),
        ).toBeUndefined();
      }),
    { exclusive: true },
  );

  it(
    "the effect fetch is authoritative inside the routes (RouteNotFound is its own 404)",
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

        // An unknown route INSIDE the claim: the HttpRouter miss renders
        // as the effect's OWN 404 response — never undefined/delegation.
        const miss = await handle.match(
          new Request("http://localhost/api/unknown"),
          { env: markers },
        );
        expect(miss).toBeDefined();
        expect(miss!.status).toBe(404);

        // A handler that matched and chose 404 keeps its body.
        const gone = await handle.match(
          new Request("http://localhost/api/gone"),
          { env: markers },
        );
        expect(gone?.status).toBe(404);
        expect(await gone!.text()).toBe("really gone");

        // The former rpc path is ordinary user route space now: inside
        // the claim it reaches the effect fetch like any other path (an
        // HttpRouter miss here — the effect's own 404, not an envelope).
        const exRpc = await handle.match(
          new Request("http://localhost/api/__rpc/bump", {
            method: "POST",
            body: "[1]",
          }),
          { env: markers },
        );
        expect(exRpc?.status).toBe(404);

        // Outside the claim: undefined — the framework's turn.
        const outside = await handle.match(
          new Request("http://localhost/assets/app.js"),
          { env: markers },
        );
        expect(outside).toBeUndefined();
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "exclusion globs carve paths back out to the framework",
    () =>
      restoringRuntimeFlag(async () => {
        const { make } = await import("@/Serve/index.ts");
        const handle = make(TestSite, {
          routes: ["/api/*", "!/api/hello*"],
        });

        // The excluded path is the framework's even though the effect
        // fetch has a handler for it.
        expect(
          await handle.match(new Request("http://localhost/api/hello"), {
            env: markers,
          }),
        ).toBeUndefined();

        // The rest of the claim stays the effect's — unknown routes are
        // its own 404.
        const miss = await handle.match(
          new Request("http://localhost/api/unknown"),
          { env: markers },
        );
        expect(miss?.status).toBe(404);
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "fetch answers path-miss declines via fallback or 404",
    () =>
      restoringRuntimeFlag(async () => {
        const { make } = await import("@/Serve/index.ts");
        const handle = make(TestSite);

        // Outside the claim → the fallback serves.
        const fromFallback = await handle.fetch(
          new Request("http://localhost/assets/app.js"),
          {
            env: markers,
            fallback: async () => new Response("framework", { status: 200 }),
          },
        );
        expect(await fromFallback.text()).toBe("framework");

        const notFound = await handle.fetch(
          new Request("http://localhost/assets/app.js"),
          { env: markers },
        );
        expect(notFound.status).toBe(404);

        // Inside the claim the effect's 404 wins — the fallback is never
        // consulted for an in-claim router miss.
        const insideMiss = await handle.fetch(
          new Request("http://localhost/api/unknown"),
          {
            env: markers,
            fallback: async () => new Response("framework", { status: 200 }),
          },
        );
        expect(insideMiss.status).toBe(404);
      }),
    { exclusive: true, timeout: 60_000 },
  );
});

describe("makeWebsiteExports", () => {
  it(
    "routes decide who serves: effect inside (authoritative), framework outside",
    () =>
      restoringRuntimeFlag(async () => {
        const { makeWebsiteExports } =
          await import("@/Cloudflare/Workers/ServeWorkerEntry.ts");

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

        // An unknown route INSIDE the claim is the effect's own 404 — the
        // framework is never consulted.
        const insideMiss: Response = await worker.fetch(
          new Request("http://localhost/api/unknown"),
        );
        expect(insideMiss.status).toBe(404);
        expect(await insideMiss.text()).not.toBe("framework");

        // No universal rpc pre-gate: the former rpc path is ordinary
        // route space — outside this claim it goes to the framework.
        const exRpcOutside: Response = await worker.fetch(
          new Request("http://localhost/other/__rpc/bump", {
            method: "POST",
            body: "[1]",
          }),
        );
        expect(await exRpcOutside.text()).toBe("framework");

        // No env markers (prerender world) → framework, no layer build.
        const guarded: any = new WebsiteWorker(ctx, {});
        const declined: Response = await guarded.fetch(
          new Request("http://localhost/api/hello"),
        );
        expect(await declined.text()).toBe("framework");
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "exclusion glob routes to the framework",
    () =>
      restoringRuntimeFlag(async () => {
        const { makeWebsiteExports } =
          await import("@/Cloudflare/Workers/ServeWorkerEntry.ts");

        class StubEntrypoint {
          constructor(
            public ctx: any,
            public env: any,
          ) {}
        }
        const WebsiteWorker = makeWebsiteExports(StubEntrypoint, {
          site: TestSite,
          routes: ["/api/*", "!/api/hello*"],
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

        // The excluded path is the framework's even though the effect
        // fetch has a handler for it.
        const excluded: Response = await worker.fetch(
          new Request("http://localhost/api/hello"),
        );
        expect(await excluded.text()).toBe("framework");

        // The rest of the claim stays the effect's.
        const insideMiss: Response = await worker.fetch(
          new Request("http://localhost/api/unknown"),
        );
        expect(insideMiss.status).toBe(404);
        expect(await insideMiss.text()).not.toBe("framework");
      }),
    { exclusive: true, timeout: 60_000 },
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Trusted-transport helpers (value-form createClient + workerd JS-RPC)
// ─────────────────────────────────────────────────────────────────────────

describe("rpc method resolution", () => {
  it("own enumerable function-valued keys only; fetch and platform handlers excluded", () => {
    const methods = rpcMethodsOf({
      bump: (n: number) => Effect.succeed(n),
      plain: () => 42,
      fetch: () => Effect.void,
      queue: () => Effect.void,
      scheduled: () => Effect.void,
      email: () => Effect.void,
      tail: () => Effect.void,
      notAFunction: 42,
      alsoNot: Effect.void,
    });
    expect(Object.keys(methods).sort()).toEqual(["bump", "plain"]);
  });

  it("empty and missing shapes resolve no methods", () => {
    expect(Object.keys(rpcMethodsOf(undefined))).toEqual([]);
    expect(Object.keys(rpcMethodsOf({}))).toEqual([]);
  });
});

describe("typed-failure encoding (encodeRpcFailure)", () => {
  it("tagged errors keep _tag and own enumerable props", () => {
    const encoded = encodeRpcFailure(
      new RpcTestError({ reason: "nope" }),
    ) as Record<string, unknown>;
    expect(encoded._tag).toBe("RpcTestError");
    expect(encoded.reason).toBe("nope");
  });

  it("a tagged Error without an own message keeps the prototype message", () => {
    class Taggedish extends Error {
      readonly _tag = "Taggedish";
    }
    const encoded = encodeRpcFailure(new Taggedish("boom")) as Record<
      string,
      unknown
    >;
    expect(encoded._tag).toBe("Taggedish");
    expect(encoded.message).toBe("boom");
  });

  it("plain Errors keep name and message only", () => {
    expect(encodeRpcFailure(new Error("kaboom"))).toEqual({
      name: "Error",
      message: "kaboom",
    });
  });

  it("primitives pass through", () => {
    expect(encodeRpcFailure("just a string")).toBe("just a string");
    expect(encodeRpcFailure(42)).toBe(42);
    expect(encodeRpcFailure(null)).toBe(null);
    expect(encodeRpcFailure(undefined)).toBe(undefined);
  });
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
