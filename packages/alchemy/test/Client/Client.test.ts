/**
 * Unit coverage for `alchemy/client` (`createClient` — the
 * frontend→backend bridge; pure-local, no cloud):
 *
 *   - the type-only form's HTTP path: proxy method call → the wire
 *     request shape (`POST {RPC_PATH}/<method>`, JSON array body,
 *     threaded headers), envelope decode (value / error / defect /
 *     non-envelope) to Promise rejections carrying `_tag`
 *   - the Effect-mode variant (`createEffectClient`): failure channel
 *     carries the decoded envelope
 *   - world detection: the type-only form called server-side with no
 *     `options.url` rejects with the typed, actionable
 *     `RpcMissingUrlError`; a browser-ish world (document + location)
 *     routes the value form onto the HTTP path
 *   - the value form's in-process dispatch against a real Website class:
 *     direct effect invocation, `options.headers` synthesized into
 *     `HttpServerRequest` (methods see cookies), REAL typed failure
 *     instances (no structural decode), unknown-method and prerender
 *     rejections
 *
 * The in-process tests stamp `globalThis.__ALCHEMY_RUNTIME__` (as any
 * real bridge construction does) — process-global state — so they take
 * the runner's whole-process write lock via `{ exclusive: true }` and
 * restore the flag in `finally`. The browser-world tests mutate
 * `globalThis.document`/`location` under the same discipline.
 */
import {
  createClient,
  createEffectClient,
  RpcDefectError,
  RpcError,
  RpcMissingUrlError,
  RpcPrerenderError,
  RpcTransportError,
} from "@/Client/index.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { RPC_PATH } from "@/Serve/Rpc.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";

const markers = {
  ALCHEMY_STACK_NAME: "client-test",
  ALCHEMY_STAGE: "test",
};

/** Run `body` with the runtime flag restored afterwards (exclusive tests). */
const restoringRuntimeFlag = async (body: () => Promise<void>) => {
  const previous = globalThis.__ALCHEMY_RUNTIME__;
  try {
    await body();
  } finally {
    globalThis.__ALCHEMY_RUNTIME__ = previous;
  }
};

// ─────────────────────────────────────────────────────────────────────────
// HTTP-path helpers: a canned-response HttpClient injected via
// `transformClient` — the wire request is captured for shape assertions.
// ─────────────────────────────────────────────────────────────────────────

interface Captured {
  request?: HttpClientRequest.HttpClientRequest;
}

const respondWith =
  (body: string, status: number, captured?: Captured) =>
  (_client: HttpClient.HttpClient): HttpClient.HttpClient =>
    HttpClient.make((request) => {
      if (captured !== undefined) {
        captured.request = request;
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, {
            status,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    });

const bodyTextOf = (request: HttpClientRequest.HttpClientRequest): string =>
  new TextDecoder().decode((request.body as { body?: Uint8Array }).body);

const rejectionOf = async (promise: Promise<unknown>): Promise<any> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
};

/** The typed failure of the in-process fixture below. */
class ClientTestError extends Data.TaggedError("ClientTestError")<{
  reason: string;
}> {}

/**
 * An effectful Website class — the value the user's `src/backend.ts`
 * default-exports. Class construction is lazy: nothing builds until the
 * value form dispatches the first call.
 */
class ClientSite extends Cloudflare.Website.Vite<ClientSite>()(
  "ClientTestSite",
  { main: import.meta.url },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return yield* Effect.die("fetch must never serve rpc calls");
      }),
      bump: (n: number) => Effect.succeed(n + 1),
      cookies: () =>
        Effect.gen(function* () {
          // Self-authorization: the synthesized per-request
          // `HttpServerRequest` carries the client's headers.
          const request = yield* HttpServerRequest;
          return request.cookies;
        }),
      fail: (reason: string) => Effect.fail(new ClientTestError({ reason })),
      whoAmI: () =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          return request.headers["x-caller"] ?? "";
        }),
    };
  }),
) {}

describe("type-only form (HTTP path)", () => {
  it("a proxy method call POSTs the wire shape at RPC_PATH", async () => {
    const captured: Captured = {};
    const backend = createClient<typeof ClientSite>({
      url: "http://backend.example",
      headers: { "x-user": "sam" },
      transformClient: respondWith(
        JSON.stringify({ value: 42 }),
        200,
        captured,
      ),
    });

    expect(await backend.bump(41)).toBe(42);

    const request = captured.request!;
    expect(request.url).toBe(`http://backend.example${RPC_PATH}/bump`);
    expect(request.method).toBe("POST");
    expect(bodyTextOf(request)).toBe("[41]");
    expect(request.headers["content-type"]).toContain("application/json");
    // Threaded per-call identity headers ride every wire call.
    expect(request.headers["x-user"]).toBe("sam");
  });

  it("a trailing slash on options.url never doubles", async () => {
    const captured: Captured = {};
    const backend = createClient<typeof ClientSite>({
      url: "http://backend.example/",
      transformClient: respondWith(JSON.stringify({ value: 1 }), 200, captured),
    });
    await backend.bump(0);
    expect(captured.request!.url).toBe(
      `http://backend.example${RPC_PATH}/bump`,
    );
  });

  it("the error envelope rejects with a structural RpcError carrying _tag + props", async () => {
    const backend = createClient<typeof ClientSite>({
      url: "http://backend.example",
      transformClient: respondWith(
        JSON.stringify({ error: { _tag: "ClientTestError", reason: "nope" } }),
        400,
      ),
    });
    const rejection = await rejectionOf(backend.fail("nope"));
    expect(rejection._tag).toBe("ClientTestError");
    expect(rejection.reason).toBe("nope");
    // Structural identity: an RpcError instance re-carrying the tag —
    // never the backend's error class (which never ships to the client).
    expect(rejection).toBeInstanceOf(RpcError);
    expect(rejection).toBeInstanceOf(Error);
  });

  it("a non-object error payload passes through verbatim", async () => {
    const backend = createClient<typeof ClientSite>({
      url: "http://backend.example",
      transformClient: respondWith(
        JSON.stringify({ error: "just a string" }),
        400,
      ),
    });
    expect(await rejectionOf((backend as any).anything())).toBe(
      "just a string",
    );
  });

  it("the defect envelope rejects with RpcDefectError (sanitized message only)", async () => {
    const backend = createClient<typeof ClientSite>({
      url: "http://backend.example",
      transformClient: respondWith(
        JSON.stringify({ defect: { message: "secret internals" } }),
        500,
      ),
    });
    const rejection = await rejectionOf(backend.bump(1));
    expect(rejection).toBeInstanceOf(RpcDefectError);
    expect(rejection.message).toBe("secret internals");
    expect(rejection.method).toBe("bump");
  });

  it("a non-envelope body rejects with RpcTransportError", async () => {
    const backend = createClient<typeof ClientSite>({
      url: "http://backend.example",
      transformClient: respondWith("<html>not the backend</html>", 404),
    });
    const rejection = await rejectionOf(backend.bump(1));
    expect(rejection).toBeInstanceOf(RpcTransportError);
    expect(rejection.message).toContain("non-JSON");
  });

  it("promise-introspection keys are not RPC methods", () => {
    const backend = createClient<typeof ClientSite>({
      url: "http://backend.example",
    });
    expect((backend as any).then).toBeUndefined();
    expect((backend as any).catch).toBeUndefined();
    expect((backend as any).finally).toBeUndefined();
    expect((backend as any).toJSON).toBeUndefined();
  });

  it("called server-side with neither a class nor a url → typed, actionable rejection", async () => {
    // The test process is a server world: no document, no location.
    const backend = createClient<typeof ClientSite>();
    const rejection = await rejectionOf(backend.bump(1));
    expect(rejection).toBeInstanceOf(RpcMissingUrlError);
    expect(rejection._tag).toBe("RpcMissingUrlError");
    // Actionable: names both escape hatches.
    expect(rejection.message).toContain("createClient(Backend)");
    expect(rejection.message).toContain("options.url");
  });
});

describe("createEffectClient (Effect mode, HTTP path)", () => {
  it("methods return Effects; success resolves the envelope value", async () => {
    const backend = createEffectClient<typeof ClientSite>({
      url: "http://backend.example",
      transformClient: respondWith(JSON.stringify({ value: 7 }), 200),
    });
    expect(await Effect.runPromise(backend.bump(6))).toBe(7);
  });

  it("the failure channel carries the decoded envelope", async () => {
    const backend = createEffectClient<typeof ClientSite>({
      url: "http://backend.example",
      transformClient: respondWith(
        JSON.stringify({
          error: { _tag: "ClientTestError", reason: "denied" },
        }),
        400,
      ),
    });
    const exit = await Effect.runPromiseExit(backend.fail("denied"));
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const fail = exit.cause.reasons.find(Cause.isFailReason);
      expect(fail).toBeDefined();
      const error = fail!.error as any;
      expect(error._tag).toBe("ClientTestError");
      expect(error.reason).toBe("denied");
      expect(error).toBeInstanceOf(RpcError);
    }
  });

  it("no url in a server world is a typed failure, not a defect", async () => {
    const backend = createEffectClient<typeof ClientSite>();
    const exit = await Effect.runPromiseExit(backend.bump(1));
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const fail = exit.cause.reasons.find(Cause.isFailReason);
      expect((fail?.error as any)?._tag).toBe("RpcMissingUrlError");
    }
  });
});

describe("world detection", () => {
  it(
    "a browser-ish world routes the VALUE form onto the HTTP path at location.origin",
    () =>
      restoringRuntimeFlag(async () => {
        const holder = globalThis as Record<string, any>;
        const previousDocument = holder.document;
        const previousLocation = holder.location;
        holder.document = {};
        holder.location = { origin: "http://browser.example" };
        try {
          const captured: Captured = {};
          // The value form in a genuine browser world falls back to the
          // wire path — the class is never built, no server dispatch.
          const backend = createClient(ClientSite, {
            transformClient: respondWith(
              JSON.stringify({ value: 5 }),
              200,
              captured,
            ),
          });
          expect(await backend.bump(4)).toBe(5);
          expect(captured.request!.url).toBe(
            `http://browser.example${RPC_PATH}/bump`,
          );

          // ... and the type-only form defaults its base to
          // location.origin.
          const typeOnly = createClient<typeof ClientSite>({
            transformClient: respondWith(
              JSON.stringify({ value: 9 }),
              200,
              captured,
            ),
          });
          expect(await typeOnly.bump(8)).toBe(9);
          expect(captured.request!.url).toBe(
            `http://browser.example${RPC_PATH}/bump`,
          );
        } finally {
          if (previousDocument === undefined) {
            delete holder.document;
          } else {
            holder.document = previousDocument;
          }
          if (previousLocation === undefined) {
            delete holder.location;
          } else {
            holder.location = previousLocation;
          }
        }
      }),
    { exclusive: true },
  );
});

describe("value form (direct in-process dispatch)", () => {
  it(
    "invokes the method effect directly and threads headers into HttpServerRequest",
    () =>
      restoringRuntimeFlag(async () => {
        const backend = createClient(ClientSite, {
          env: markers,
          headers: { cookie: "session=abc; user=sam" },
        });

        expect(await backend.bump(41)).toBe(42);

        // The synthesized per-request HttpServerRequest carries the
        // client's headers: the method sees the cookies.
        expect(await backend.cookies()).toEqual({
          session: "abc",
          user: "sam",
        });
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "typed failures are the REAL error instances (no envelope, no structural decode)",
    () =>
      restoringRuntimeFlag(async () => {
        const backend = createClient(ClientSite, { env: markers });
        const rejection = await rejectionOf(backend.fail("denied"));
        expect(rejection).toBeInstanceOf(ClientTestError);
        expect(rejection._tag).toBe("ClientTestError");
        expect(rejection.reason).toBe("denied");
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "an unknown method rejects with the RpcMethodNotFound tag",
    () =>
      restoringRuntimeFlag(async () => {
        const backend = createClient(ClientSite, { env: markers });
        const rejection = await rejectionOf((backend as any).nope());
        expect(rejection._tag).toBe("RpcMethodNotFound");
        expect(rejection.method).toBe("nope");
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "headers default to empty: no cookies without options.headers",
    () =>
      restoringRuntimeFlag(async () => {
        const backend = createClient(ClientSite, { env: markers });
        expect(await backend.cookies()).toEqual({});
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "a prerender world (no stack markers) rejects with the typed, actionable RpcPrerenderError",
    () =>
      restoringRuntimeFlag(async () => {
        const backend = createClient(ClientSite, { env: {} });
        const rejection = await rejectionOf(backend.bump(1));
        expect(rejection).toBeInstanceOf(RpcPrerenderError);
        expect(rejection._tag).toBe("RpcPrerenderError");
        expect(rejection.message).toContain("prerender");
        expect(rejection.message).toContain("dynamic");
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "the Effect-mode value form carries the real failure in the failure channel",
    () =>
      restoringRuntimeFlag(async () => {
        const backend = createEffectClient(ClientSite, { env: markers });

        expect(await Effect.runPromise(backend.bump(1))).toBe(2);

        const exit = await Effect.runPromiseExit(backend.fail("stop"));
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const fail = exit.cause.reasons.find(Cause.isFailReason);
          expect(fail?.error).toBeInstanceOf(ClientTestError);
          expect((fail?.error as ClientTestError).reason).toBe("stop");
        }
      }),
    { exclusive: true, timeout: 60_000 },
  );
});

describe("headers thunk (shared-client per-request identity)", () => {
  it(
    "resolves the thunk per call — concurrent calls see their own headers",
    () =>
      restoringRuntimeFlag(async () => {
        globalThis.__ALCHEMY_RUNTIME__ = true;
        // A shared, module-scope-style client whose headers come from an
        // ambient accessor (the TanStack getRequestHeaders / Next headers
        // pattern). Each call must observe the value AT CALL TIME.
        let current = "";
        const backend = createClient(ClientSite, {
          env: markers,
          headers: () => ({ "x-caller": current }),
        });
        current = "first";
        const a = backend.whoAmI();
        current = "second";
        const b = backend.whoAmI();
        // The second thunk resolution must not clobber the first call's
        // synthesized request (headers resolve before dispatch, per call).
        const [ra, rb] = await Promise.all([a, b]);
        expect([ra, rb]).toContain("second");
        // Sequential calls definitely observe the latest ambient value.
        current = "third";
        expect(await backend.whoAmI()).toBe("third");
      }),
    { exclusive: true },
  );
});
