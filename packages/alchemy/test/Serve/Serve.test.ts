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
 *
 * The runtime tests stamp `globalThis.__ALCHEMY_RUNTIME__` (as any real
 * bridge construction does), which is process-global state — they take the
 * runner's whole-process write lock via `{ exclusive: true }` and restore
 * the flag in `finally`. The bridge modules that stamp at module evaluation
 * (`@/Serve/Worker.ts`) are imported dynamically inside those tests for the
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
import {
  dispatchRpc,
  isRpcPath,
  RPC_CLAIM,
  RPC_PATH,
  rpcMethodsOf,
  withRpcClaim,
  withRpcDispatch,
} from "@/Serve/Rpc.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { RouteNotFound } from "effect/unstable/http/HttpServerError";
import * as ServerRequest from "effect/unstable/http/HttpServerRequest";
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

/** Flipped by `RpcSite.finalized`'s request finalizer. */
let rpcFinalizerRan = false;

class RpcSite extends Cloudflare.Website.Vite<RpcSite>()(
  "ServeRpcSite",
  { main: import.meta.url },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("fetched");
      }),
      bump: (n: number) => Effect.succeed(n + 1),
      whoami: () =>
        Effect.gen(function* () {
          // Self-authorization: the per-request pipeline puts
          // `HttpServerRequest` in context for RPC methods.
          const request = yield* HttpServerRequest;
          return request.headers["x-user"] ?? null;
        }),
      fail: (reason: string) => Effect.fail(new RpcTestError({ reason })),
      boom: () => Effect.die(new Error("secret internals")),
      finalized: () =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              rpcFinalizerRan = true;
            }),
          );
          return "ok";
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
        const { makeWebsiteExports } = await import("@/Serve/Worker.ts");

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
        const { makeWebsiteExports } = await import("@/Serve/Worker.ts");

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
// The createClient wire protocol (dispatch half)
// ─────────────────────────────────────────────────────────────────────────

/** Run one `dispatchRpc` request against a plain impl shape (pure-unit). */
const runRpc = (
  shape: Record<string, unknown> | undefined,
  request: Request,
): Promise<Response> =>
  Effect.runPromise(
    Effect.scoped(
      dispatchRpc(shape).pipe(
        Effect.map((response) => HttpServerResponse.toWeb(response)),
        Effect.provideService(
          HttpServerRequest,
          ServerRequest.fromWeb(request),
        ),
      ),
    ),
  );

const rpcPost = (method: string, body?: string): Request =>
  new Request(`http://localhost${RPC_PATH}/${method}`, {
    method: "POST",
    ...(body !== undefined ? { body } : {}),
  });

describe("rpc protocol constants", () => {
  it("RPC_PATH is the universal /api/__rpc", () => {
    expect(RPC_PATH).toBe("/api/__rpc");
    expect(RPC_CLAIM).toBe("/api/__rpc*");
  });

  it("withRpcClaim appends unless a rule covers or collides", () => {
    // Not covered → appended (including the empty method-only list).
    expect(withRpcClaim([])).toEqual([RPC_CLAIM]);
    expect(withRpcClaim(["/other/*"])).toEqual(["/other/*", RPC_CLAIM]);
    // Covered by a wider glob → skipped (Cloudflare's run_worker_first
    // parser rejects redundant rules).
    expect(withRpcClaim(["/api/*"])).toEqual(["/api/*"]);
    expect(withRpcClaim(["/*"])).toEqual(["/*"]);
    expect(withRpcClaim([RPC_CLAIM])).toEqual([RPC_CLAIM]);
    // A rule inside the reserved space collides (the claim would make it
    // redundant) → skipped rather than producing an invalid rule set.
    expect(withRpcClaim(["/api/__rpc/special*"])).toEqual([
      "/api/__rpc/special*",
    ]);
    // Negative rules neither cover nor collide.
    expect(withRpcClaim(["!/api/*", "/other/*"])).toEqual([
      "!/api/*",
      "/other/*",
      RPC_CLAIM,
    ]);
  });

  it("isRpcPath is method-boundary-safe", () => {
    expect(isRpcPath("/api/__rpc")).toBe(true);
    expect(isRpcPath("/api/__rpc/bump")).toBe(true);
    expect(isRpcPath("/api/__rpc/a/b")).toBe(true);
    // Sibling paths stay with the user's routes.
    expect(isRpcPath("/api/__rpcx")).toBe(false);
    expect(isRpcPath("/api/__rp")).toBe(false);
    expect(isRpcPath("/__rpc__/call")).toBe(false);
  });
});

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

describe("rpc envelope codec (dispatchRpc)", () => {
  const shape = {
    bump: (n: number) => Effect.succeed(n + 1),
    concat: (a: string, b: string) => Effect.succeed(a + b),
    nothing: () => Effect.void,
    plain: (n: number) => n * 2,
    throws: () => {
      throw new Error("sync kaboom");
    },
    fail: (reason: string) => Effect.fail(new RpcTestError({ reason })),
    failPlain: () => Effect.fail("just a string"),
    boom: () => Effect.die(new Error("secret internals")),
    fetch: () => Effect.void,
    queue: () => Effect.void,
  };

  it("success value → 200 {value}", async () => {
    const res = await runRpc(shape, rpcPost("bump", "[41]"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ value: 42 });
  });

  it("positional args are applied in order", async () => {
    const res = await runRpc(shape, rpcPost("concat", '["a","b"]'));
    expect(await res.json()).toEqual({ value: "ab" });
  });

  it("void/undefined success → {value: null}", async () => {
    const res = await runRpc(shape, rpcPost("nothing", "[]"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: null });
  });

  it("empty body means no arguments", async () => {
    const res = await runRpc(shape, rpcPost("nothing"));
    expect(res.status).toBe(200);
  });

  it("non-Effect return values pass through as the success value", async () => {
    const res = await runRpc(shape, rpcPost("plain", "[21]"));
    expect(await res.json()).toEqual({ value: 42 });
  });

  it("typed failure → 400 {error: {_tag, ...props}}", async () => {
    const res = await runRpc(shape, rpcPost("fail", '["nope"]'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error._tag).toBe("RpcTestError");
    expect(body.error.reason).toBe("nope");
  });

  it("non-tagged failure passes through the error envelope", async () => {
    const res = await runRpc(shape, rpcPost("failPlain", "[]"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "just a string" });
  });

  it("defect → 500 sanitized {defect: {message}} (no stack/internals)", async () => {
    const res = await runRpc(shape, rpcPost("boom", "[]"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.defect.message).toBe("secret internals");
    expect(Object.keys(body)).toEqual(["defect"]);
    expect(Object.keys(body.defect)).toEqual(["message"]);
  });

  it("a synchronous throw is a defect", async () => {
    const res = await runRpc(shape, rpcPost("throws", "[]"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.defect.message).toBe("sync kaboom");
  });

  it("unknown method → 404 RpcMethodNotFound", async () => {
    const res = await runRpc(shape, rpcPost("missing", "[]"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { _tag: "RpcMethodNotFound", method: "missing" },
    });
  });

  it("fetch and platform handler keys are NOT dispatchable", async () => {
    for (const name of ["fetch", "queue"]) {
      const res = await runRpc(shape, rpcPost(name, "[]"));
      expect(res.status).toBe(404);
    }
  });

  it("the bare rpc path (no method segment) → 404", async () => {
    const res = await runRpc(
      shape,
      new Request(`http://localhost${RPC_PATH}`, {
        method: "POST",
        body: "[]",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("a method-less shape answers RpcMethodNotFound (never throws)", async () => {
    const res = await runRpc(undefined, rpcPost("anything", "[]"));
    expect(res.status).toBe(404);
  });

  it("non-POST verbs → 405 RpcMethodNotAllowed", async () => {
    const res = await runRpc(
      shape,
      new Request(`http://localhost${RPC_PATH}/bump`, { method: "GET" }),
    );
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({
      error: { _tag: "RpcMethodNotAllowed", method: "GET" },
    });
  });

  it("malformed JSON body → 400 RpcInvalidArguments", async () => {
    const res = await runRpc(shape, rpcPost("bump", "{not json"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error._tag).toBe("RpcInvalidArguments");
  });

  it("non-array JSON body → 400 RpcInvalidArguments", async () => {
    const res = await runRpc(shape, rpcPost("bump", '{"n": 1}'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error._tag).toBe("RpcInvalidArguments");
    expect(body.error.message).toContain("JSON array");
  });

  it("a non-JSON-serializable success value → sanitized 500", async () => {
    const circular: any = {};
    circular.self = circular;
    const res = await runRpc(
      { cycle: () => Effect.succeed(circular) },
      rpcPost("cycle", "[]"),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.defect.message).toContain("not JSON-serializable");
  });
});

describe("withRpcDispatch (the plain effect path)", () => {
  const shape = {
    fetch: Effect.succeed(HttpServerResponse.text("from-fetch")),
    bump: (n: number) => Effect.succeed(n + 1),
  };

  const run = (request: Request): Promise<Response> =>
    Effect.runPromise(
      Effect.scoped(
        withRpcDispatch(shape, shape.fetch).pipe(
          Effect.map((response: HttpServerResponse.HttpServerResponse) =>
            HttpServerResponse.toWeb(response),
          ),
          Effect.provideService(
            HttpServerRequest,
            ServerRequest.fromWeb(request),
          ),
        ),
      ) as Effect.Effect<Response, never, never>,
    );

  it("dispatches the rpc path; everything else runs the fetch fallback", async () => {
    const rpc = await run(rpcPost("bump", "[1]"));
    expect(rpc.status).toBe(200);
    expect(await rpc.json()).toEqual({ value: 2 });

    const fetched = await run(new Request("http://localhost/api/other"));
    expect(await fetched.text()).toBe("from-fetch");

    // The internal worker-to-worker transport path is never shadowed.
    const internal = await run(
      new Request("http://localhost/__rpc__/call", { method: "POST" }),
    );
    expect(await internal.text()).toBe("from-fetch");
  });

  it("resolves an init-Effect fallback (the Main.fetch dual shape)", async () => {
    const response = await Effect.runPromise(
      Effect.scoped(
        withRpcDispatch(
          shape,
          Effect.succeed(Effect.succeed(HttpServerResponse.text("lazy"))),
        ).pipe(
          Effect.map((r: HttpServerResponse.HttpServerResponse) =>
            HttpServerResponse.toWeb(r),
          ),
          Effect.provideService(
            HttpServerRequest,
            ServerRequest.fromWeb(new Request("http://localhost/anything")),
          ),
        ),
      ) as Effect.Effect<Response, never, never>,
    );
    expect(await response.text()).toBe("lazy");
  });
});

describe("Serve.make rpc dispatch", () => {
  it(
    "dispatches POST /api/__rpc/<method> through the per-request pipeline",
    () =>
      restoringRuntimeFlag(async () => {
        const { make } = await import("@/Serve/index.ts");
        const handle = make(RpcSite);

        const hit = await handle.match(rpcPost("bump", "[1]"), {
          env: markers,
        });
        expect(hit?.status).toBe(200);
        expect(await hit!.json()).toEqual({ value: 2 });

        // Typed failures ride the error envelope.
        const failed = await handle.match(rpcPost("fail", '["denied"]'), {
          env: markers,
        });
        expect(failed?.status).toBe(400);
        const failBody = (await failed!.json()) as any;
        expect(failBody.error._tag).toBe("RpcTestError");
        expect(failBody.error.reason).toBe("denied");

        // Defects are sanitized.
        const boomed = await handle.match(rpcPost("boom", "[]"), {
          env: markers,
        });
        expect(boomed?.status).toBe(500);
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "the rpc path needs no routes claim (dispatched outside server.routes)",
    () =>
      restoringRuntimeFlag(async () => {
        const { make } = await import("@/Serve/index.ts");
        // The claim owns /other/* only — /api/__rpc is outside it, yet the
        // dispatch answers because the rpc check runs BEFORE routes.
        const handle = make(RpcSite, { routes: ["/other/*"] });
        const hit = await handle.match(rpcPost("bump", "[9]"), {
          env: markers,
        });
        expect(hit?.status).toBe(200);
        expect(await hit!.json()).toEqual({ value: 10 });

        // ... while a plain /api path outside the claim still declines.
        expect(
          await handle.match(new Request("http://localhost/api/x"), {
            env: markers,
          }),
        ).toBeUndefined();
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "HttpServerRequest is in context: methods self-authorize from headers",
    () =>
      restoringRuntimeFlag(async () => {
        const { make } = await import("@/Serve/index.ts");
        const handle = make(RpcSite);
        const res = await handle.match(
          new Request(`http://localhost${RPC_PATH}/whoami`, {
            method: "POST",
            headers: { "x-user": "sam" },
            body: "[]",
          }),
          { env: markers },
        );
        expect(res?.status).toBe(200);
        expect(await res!.json()).toEqual({ value: "sam" });
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "request finalizers settle after the rpc response (same semantics as fetch)",
    () =>
      restoringRuntimeFlag(async () => {
        const { make } = await import("@/Serve/index.ts");
        const handle = make(RpcSite);
        rpcFinalizerRan = false;
        const res = await handle.match(rpcPost("finalized", "[]"), {
          env: markers,
        });
        expect(res?.status).toBe(200);
        expect(await res!.json()).toEqual({ value: "ok" });
        // No waitUntil pin on the default bridge — the request scope is
        // settled by the time the response resolves (or one macrotask
        // later at most).
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(rpcFinalizerRan).toBe(true);
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "a method-less site answers the 404 envelope at the reserved path",
    () =>
      restoringRuntimeFlag(async () => {
        const { make } = await import("@/Serve/index.ts");
        // TestSite serves only fetch — the reserved path still answers
        // with the rpc envelope, never the fetch handler.
        const handle = make(TestSite);
        const res = await handle.match(rpcPost("anything", "[]"), {
          env: markers,
        });
        expect(res?.status).toBe(404);
        expect(await res!.json()).toEqual({
          error: { _tag: "RpcMethodNotFound", method: "anything" },
        });
      }),
    { exclusive: true, timeout: 60_000 },
  );
});

describe("makeWebsiteExports rpc dispatch", () => {
  it(
    "the wrapper dispatches the rpc path before routes; framework never consulted",
    () =>
      restoringRuntimeFlag(async () => {
        const { makeWebsiteExports } = await import("@/Serve/Worker.ts");
        class StubEntrypoint {
          constructor(
            public ctx: any,
            public env: any,
          ) {}
        }
        const WebsiteWorker = makeWebsiteExports(StubEntrypoint, {
          site: RpcSite,
          // The rpc path is outside the routes claim on purpose.
          routes: ["/other/*"],
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

        const hit: Response = await worker.fetch(rpcPost("bump", "[41]"));
        expect(hit.status).toBe(200);
        expect(await hit.json()).toEqual({ value: 42 });

        // Unknown method at the reserved path: the 404 envelope is final —
        // the framework is never consulted.
        const miss: Response = await worker.fetch(rpcPost("nope", "[]"));
        expect(miss.status).toBe(404);
        expect((await miss.json()) as any).toEqual({
          error: { _tag: "RpcMethodNotFound", method: "nope" },
        });

        // No env markers (prerender world) → framework serves the path.
        const guarded: any = new WebsiteWorker(ctx, {});
        const declined: Response = await guarded.fetch(rpcPost("bump", "[1]"));
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
