/**
 * Unit coverage for the AWS fetch-shaped runtime bridge (pure-local, no
 * cloud):
 *
 *   - `makeFunctionFetchHandler` preserves STREAMED response bodies — the
 *     web `Response` resolves while the body stream is still being
 *     produced (the Phase-0 spike obligation: streaming survives the
 *     fetch-layer composition that rides a framework's `toLambdaHandler`
 *     pipe), and the request scope is transferred to the stream (its
 *     finalizers run at stream completion) instead of settling inline;
 *   - `makeWebsiteHandlers` dispatch — strict route ownership: inside
 *     `routes` the effect fetch is authoritative (a `RouteNotFound`
 *     failure renders as the effect's own 404 response), `match` resolves
 *     `undefined` ONLY for paths outside the routes, the four-worlds
 *     guard (no stack markers → decline without building layers), and
 *     `fetch`'s fallback/404 answers.
 *
 * The `makeWebsiteHandlers` tests stamp `globalThis.__ALCHEMY_RUNTIME__`
 * (as any real bridge construction does) — process-global state — so they
 * take the runner's whole-process write lock via `{ exclusive: true }` and
 * restore the flag in `finally`.
 */
import * as AWS from "@/AWS";
import { makeFunctionFetchHandler } from "@/AWS/Lambda/HttpServer.ts";
import { makeWebsiteHandlers } from "@/AWS/Lambda/WebsiteHandlers.ts";
import { RPC_PATH } from "@/Serve/Rpc.ts";
import { describe, expect, it } from "alchemy-test";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { RouteNotFound } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const markers = {
  ALCHEMY_STACK_NAME: "fetch-handler-test",
  ALCHEMY_STAGE: "test",
};

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? "" : new TextDecoder().decode(bytes);

/** Run `body` with the runtime flag restored afterwards (exclusive tests). */
const restoringRuntimeFlag = async (body: () => Promise<void>) => {
  const previous = globalThis.__ALCHEMY_RUNTIME__;
  try {
    await body();
  } finally {
    globalThis.__ALCHEMY_RUNTIME__ = previous;
  }
};

/**
 * An effectful site class hosted on the Lambda platform — the value shape a
 * user's `site.ts` default-exports. Constructing the class is lazy; the
 * impl only evaluates when `makeWebsiteHandlers` builds the layer stack.
 */
class FetchSite extends AWS.Website.StaticSite<FetchSite>()(
  "FetchHandlerSite",
  { path: import.meta.dirname, main: import.meta.url },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/api/hello")) {
          return HttpServerResponse.text("hi from effect");
        }
        if (request.url.startsWith("/api/gone")) {
          // A handler that matched and chose 404: stays a 404 carrying
          // this body.
          return HttpServerResponse.text("really gone", { status: 404 });
        }
        // The HttpRouter miss: renders as the effect's own 404 response
        // through the standard pipeline — never delegation.
        return yield* Effect.fail(new RouteNotFound({ request }));
      }),
    };
  }),
) {}

class RpcFetchError extends Data.TaggedError("RpcFetchError")<{
  reason: string;
}> {}

/**
 * An effectful site with RPC methods beside the fetch handler — the shape
 * `createClient` dispatches to over `POST /api/__rpc/<method>`.
 */
class RpcFetchSite extends AWS.Website.StaticSite<RpcFetchSite>()(
  "RpcFetchHandlerSite",
  { path: import.meta.dirname, main: import.meta.url },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("fetched");
      }),
      bump: (n: number) => Effect.succeed(n + 1),
      whoami: () =>
        Effect.gen(function* () {
          // Self-authorization: the per-event pipeline puts
          // `HttpServerRequest` in context for RPC methods.
          const request = yield* HttpServerRequest;
          return request.headers["x-user"] ?? null;
        }),
      fail: (reason: string) => Effect.fail(new RpcFetchError({ reason })),
    };
  }),
) {}

const rpcPost = (method: string, body?: string, headers?: HeadersInit) =>
  new Request(`http://localhost${RPC_PATH}/${method}`, {
    method: "POST",
    ...(headers !== undefined ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
  });

describe("makeFunctionFetchHandler", () => {
  it("returns buffered responses; request finalizers settle before the Response", async () => {
    let finalized = false;
    const response = await Effect.runPromise(
      makeFunctionFetchHandler(
        Effect.gen(function* () {
          // Attaches to `toHandled`'s internal request scope.
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              finalized = true;
            }),
          );
          return HttpServerResponse.text("hello world");
        }),
      )(new Request("http://localhost/api/hello")),
    );
    expect(response.status).toBe(200);
    // Lambda semantics: the request scope settles inline, BEFORE the
    // Response resolves to the caller.
    expect(finalized).toBe(true);
    expect(await response.text()).toBe("hello world");
  });

  it("preserves streamed bodies (the Response resolves before the body finishes)", async () => {
    const gate = Effect.runSync(Deferred.make<void>());
    let finalized: (() => void) | undefined;
    const finalizerRan = new Promise<void>((resolve) => {
      finalized = resolve;
    });
    let finalizerDone = false;
    const body = Stream.concat(
      Stream.succeed(encode("first-chunk;")),
      // The tail chunk is gated: if the bridge buffered the body, awaiting
      // the Response below would deadlock (the gate only opens after the
      // Response arrived).
      Stream.fromEffect(
        Deferred.await(gate).pipe(Effect.as(encode("second-chunk"))),
      ),
    );

    const response = await Effect.runPromise(
      makeFunctionFetchHandler(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              finalizerDone = true;
              finalized!();
            }),
          );
          return HttpServerResponse.stream(body, {
            contentType: "text/plain",
          });
        }),
      )(new Request("http://localhost/api/stream")),
    );
    expect(response.status).toBe(200);
    // Ownership of the request scope transferred to the stream: the
    // Response resolved while the body is still open, and the request
    // finalizer has NOT run yet.
    expect(finalizerDone).toBe(false);

    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decode(first.value)).toContain("first-chunk");
    expect(finalizerDone).toBe(false);

    // Only now let the producer emit the rest.
    Effect.runSync(Deferred.succeed(gate, undefined));
    let rest = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += decode(chunk.value);
    }
    expect(rest).toContain("second-chunk");

    // ... and the request scope closes when the stream completes.
    await finalizerRan;
    expect(finalizerDone).toBe(true);
  });
});

describe("makeWebsiteHandlers", () => {
  it(
    "routes decide who serves: effect inside (authoritative), decline outside",
    () =>
      restoringRuntimeFlag(async () => {
        const site = makeWebsiteHandlers({
          site: FetchSite,
          routes: ["/api/*"],
          env: markers,
        });

        // Outside routes → decline without touching the effect fetch.
        expect(
          await site.match(new Request("http://localhost/assets/app.js")),
        ).toBeUndefined();

        // Inside routes → effect fetch.
        const hit = await site.match(new Request("http://localhost/api/hello"));
        expect(hit?.status).toBe(200);
        expect(await hit!.text()).toBe("hi from effect");

        // An unknown route INSIDE the claim: the HttpRouter miss renders
        // as the effect's OWN 404 response — never undefined/delegation.
        const miss = await site.match(
          new Request("http://localhost/api/unknown"),
        );
        expect(miss).toBeDefined();
        expect(miss!.status).toBe(404);

        // A handler that matched and chose 404 keeps its body.
        const gone = await site.match(new Request("http://localhost/api/gone"));
        expect(gone?.status).toBe(404);
        expect(await gone!.text()).toBe("really gone");

        // fetch answers path-miss declines via the fallback, else 404.
        const fromFallback = await site.fetch(
          new Request("http://localhost/assets/app.js"),
          { fallback: async () => new Response("framework") },
        );
        expect(await fromFallback.text()).toBe("framework");
        const notFound = await site.fetch(
          new Request("http://localhost/assets/app.js"),
        );
        expect(notFound.status).toBe(404);

        // Inside the claim the effect's 404 wins — the fallback is never
        // consulted for an in-claim router miss.
        const insideMiss = await site.fetch(
          new Request("http://localhost/api/unknown"),
          { fallback: async () => new Response("framework") },
        );
        expect(insideMiss.status).toBe(404);
        expect(await insideMiss.text()).not.toBe("framework");
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "exclusion glob routes to the framework",
    () =>
      restoringRuntimeFlag(async () => {
        const site = makeWebsiteHandlers({
          site: FetchSite,
          routes: ["/api/*", "!/api/hello*"],
          env: markers,
        });

        // The excluded path declines even though the effect fetch has a
        // handler for it — the framework serves it.
        expect(
          await site.match(new Request("http://localhost/api/hello")),
        ).toBeUndefined();

        // The rest of the claim stays the effect's — unknown routes are
        // its own 404.
        const miss = await site.match(
          new Request("http://localhost/api/unknown"),
        );
        expect(miss?.status).toBe(404);
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "declines without alchemy env markers (four-worlds guard)",
    () =>
      restoringRuntimeFlag(async () => {
        // A fake class proves no layer build is attempted on decline.
        class NeverBuilt {
          static readonly LogicalId = "NeverBuilt";
        }
        const site = makeWebsiteHandlers({
          site: NeverBuilt as any,
          routes: ["/api/*"],
          env: { NOT_ALCHEMY: "1" },
        });
        expect(
          await site.match(new Request("http://localhost/api/hello")),
        ).toBeUndefined();
      }),
    { exclusive: true },
  );

  it(
    "rpc dispatch: value + typed failure envelopes through the per-event pipeline",
    () =>
      restoringRuntimeFlag(async () => {
        const site = makeWebsiteHandlers({
          site: RpcFetchSite,
          // The rpc path is outside the routes claim on purpose — the
          // dispatch is checked BEFORE routes and needs no claim.
          routes: ["/other/*"],
          env: markers,
        });

        const hit = await site.match(rpcPost("bump", "[41]"));
        expect(hit?.status).toBe(200);
        expect(await hit!.json()).toEqual({ value: 42 });

        // Typed failures ride the error envelope with _tag + props.
        const failed = await site.match(rpcPost("fail", '["denied"]'));
        expect(failed?.status).toBe(400);
        const failBody = (await failed!.json()) as any;
        expect(failBody.error._tag).toBe("RpcFetchError");
        expect(failBody.error.reason).toBe("denied");

        // Unknown method: the 404 envelope is final — never `undefined`
        // (the framework is not consulted at the reserved path).
        const miss = await site.match(rpcPost("nope", "[]"));
        expect(miss?.status).toBe(404);
        expect(await miss!.json()).toEqual({
          error: { _tag: "RpcMethodNotFound", method: "nope" },
        });

        // ... while a plain path outside the claim still declines.
        expect(
          await site.match(new Request("http://localhost/api/x")),
        ).toBeUndefined();
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "rpc methods see the request headers (HttpServerRequest in context)",
    () =>
      restoringRuntimeFlag(async () => {
        const site = makeWebsiteHandlers({ site: RpcFetchSite, env: markers });
        const res = await site.match(
          rpcPost("whoami", "[]", { "x-user": "sam" }),
        );
        expect(res?.status).toBe(200);
        expect(await res!.json()).toEqual({ value: "sam" });
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "omitted routes default to DEFAULT_SERVER_ROUTES (/api/*)",
    () =>
      restoringRuntimeFlag(async () => {
        const site = makeWebsiteHandlers({ site: FetchSite, env: markers });
        const hit = await site.match(new Request("http://localhost/api/hello"));
        expect(await hit!.text()).toBe("hi from effect");
        // Outside the default claim → decline (the framework serves).
        expect(
          await site.match(new Request("http://localhost/anything")),
        ).toBeUndefined();
      }),
    { exclusive: true, timeout: 60_000 },
  );
});
