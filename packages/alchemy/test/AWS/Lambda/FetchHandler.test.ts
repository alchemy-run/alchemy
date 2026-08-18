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
 *   - `mount` dispatch over the AWS bridge — the user's mount owns
 *     routing: inside its `routes` claim the effect fetch is authoritative
 *     (a `RouteNotFound` failure renders as the effect's own 404
 *     response), `fetch` resolves `undefined` ONLY for paths outside the
 *     claim, and the four-worlds guard (no stack markers → decline
 *     without building layers) holds;
 *   - `makeFrameworkFunctionHandler` (the single-handler composite entry,
 *     buffered fallback outside the Lambda sandbox): HTTP-shaped events
 *     go to the FRAMEWORK's fetch — never the site program's own HTTP
 *     listener — and non-HTTP events dispatch through the program's
 *     registered listeners.
 *
 * The mount tests stamp `globalThis.__ALCHEMY_RUNTIME__` (as any real
 * bridge construction does) — process-global state — so they take the
 * runner's whole-process write lock via `{ exclusive: true }` and restore
 * the flag in `finally`.
 */
import * as AWS from "@/AWS";
import { makeFunctionFetchHandler } from "@/AWS/Lambda/HttpServer.ts";
import { makeFrameworkFunctionHandler, mount } from "@/AWS/Lambda/Serve.ts";
import { describe, expect, it } from "alchemy-test";
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
 * user's `backend.ts` default-exports. Constructing the class is lazy; the
 * impl only evaluates when the bridge builds the layer stack.
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

describe("mount (AWS bridge)", () => {
  it(
    "the mount's routes decide who serves: effect inside (authoritative), decline outside",
    () =>
      restoringRuntimeFlag(async () => {
        const site = mount(FetchSite, { routes: ["/api/*"], env: markers });

        // Outside the claim → decline without touching the effect fetch.
        expect(
          await site.fetch(new Request("http://localhost/assets/app.js")),
        ).toBeUndefined();

        // Inside the claim → effect fetch.
        const hit = await site.fetch(new Request("http://localhost/api/hello"));
        expect(hit?.status).toBe(200);
        expect(await hit!.text()).toBe("hi from effect");

        // An unknown route INSIDE the claim: the HttpRouter miss renders
        // as the effect's OWN 404 response — never undefined/delegation.
        const miss = await site.fetch(
          new Request("http://localhost/api/unknown"),
        );
        expect(miss).toBeDefined();
        expect(miss!.status).toBe(404);

        // A handler that matched and chose 404 keeps its body.
        const gone = await site.fetch(new Request("http://localhost/api/gone"));
        expect(gone?.status).toBe(404);
        expect(await gone!.text()).toBe("really gone");
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "exclusion glob hands a path back to the framework",
    () =>
      restoringRuntimeFlag(async () => {
        const site = mount(FetchSite, {
          routes: ["/api/*", "!/api/hello*"],
          env: markers,
        });

        // The excluded path declines even though the effect fetch has a
        // handler for it — the framework serves it.
        expect(
          await site.fetch(new Request("http://localhost/api/hello")),
        ).toBeUndefined();

        // The rest of the claim stays the effect's — unknown routes are
        // its own 404.
        const miss = await site.fetch(
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
        const site = mount(NeverBuilt as any, {
          routes: ["/api/*"],
          env: { NOT_ALCHEMY: "1" },
        });
        expect(
          await site.fetch(new Request("http://localhost/api/hello")),
        ).toBeUndefined();
      }),
    { exclusive: true },
  );

  it(
    "omitted routes default to DEFAULT_SERVER_ROUTES (/api/*)",
    () =>
      restoringRuntimeFlag(async () => {
        const site = mount(FetchSite, { env: markers });
        const hit = await site.fetch(new Request("http://localhost/api/hello"));
        expect(await hit!.text()).toBe("hi from effect");
        // Outside the default claim → decline (the framework serves).
        expect(
          await site.fetch(new Request("http://localhost/anything")),
        ).toBeUndefined();
      }),
    { exclusive: true, timeout: 60_000 },
  );
});

describe("makeFrameworkFunctionHandler", () => {
  /** A minimal Function URL (payload v2) event. */
  const functionUrlEvent = (path: string) => ({
    version: "2.0",
    rawPath: path,
    rawQueryString: "",
    headers: {
      host: "example.lambda-url.us-east-1.on.aws",
      "x-forwarded-proto": "https",
    },
    requestContext: {
      domainName: "example.lambda-url.us-east-1.on.aws",
      http: { method: "GET", sourceIp: "127.0.0.1" },
    },
  });

  it(
    "routes HTTP-shaped events to the FRAMEWORK's fetch, never the site's HTTP listener",
    () =>
      restoringRuntimeFlag(async () => {
        const previousEnv = {
          ALCHEMY_STACK_NAME: process.env.ALCHEMY_STACK_NAME,
          ALCHEMY_STAGE: process.env.ALCHEMY_STAGE,
        };
        process.env.ALCHEMY_STACK_NAME = markers.ALCHEMY_STACK_NAME;
        process.env.ALCHEMY_STAGE = markers.ALCHEMY_STAGE;
        try {
          const seen: Array<string> = [];
          const handler = (await makeFrameworkFunctionHandler({
            site: FetchSite,
            fetch: async (request) => {
              seen.push(new URL(request.url).pathname);
              return new Response("from the framework", {
                status: 200,
                headers: { "content-type": "text/plain" },
              });
            },
          })) as (event: any, context: any) => Promise<any>;

          // Outside the Lambda sandbox (no `awslambda` global) the wrapper
          // returns the buffered `(event, context)` form.
          const result = await handler(functionUrlEvent("/api/hello"), {});
          // The site's own fetch has a handler for /api/hello — but HTTP
          // belongs to the framework (whose body carries the user's
          // mount), so the framework answered.
          expect(seen).toEqual(["/api/hello"]);
          expect(result.statusCode).toBe(200);
          expect(result.body).toBe("from the framework");

          // A non-HTTP event dispatches through the program's listeners —
          // this fetch-only program has none, which is a loud error (the
          // plain effect entry's exact behavior).
          await expect(
            handler({ Records: [{ eventSource: "aws:nothing" }] }, {}),
          ).rejects.toThrow("No event handler found");
        } finally {
          process.env.ALCHEMY_STACK_NAME = previousEnv.ALCHEMY_STACK_NAME;
          process.env.ALCHEMY_STAGE = previousEnv.ALCHEMY_STAGE;
        }
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it("requires exactly one of fetch / streamHandler", async () => {
    await expect(
      makeFrameworkFunctionHandler({ site: FetchSite } as any),
    ).rejects.toThrow("exactly one");
    await expect(
      makeFrameworkFunctionHandler({
        site: FetchSite,
        fetch: async () => new Response("x"),
        streamHandler: async () => {},
      } as any),
    ).rejects.toThrow("exactly one");
  });
});
