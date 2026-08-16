/**
 * Unit coverage for `alchemy/Client` (`createClient` — the server-side
 * bridge into a backend's methods; pure-local, no cloud):
 *
 *   - the value form's in-process dispatch against a real Website class:
 *     direct effect invocation, `options.headers` synthesized into
 *     `HttpServerRequest` (methods see cookies), REAL typed failure
 *     instances (no envelope, no structural decode), unknown-method and
 *     prerender rejections
 *   - the Effect-mode variant (`createEffectClient`): the failure channel
 *     carries the real failure instance
 *   - per-call headers-thunk snapshot: concurrent calls on a shared
 *     client never cross identities
 *   - the serve-shell runtime seam (AWS classes)
 *   - calling `createClient` without a Backend class throws the
 *     actionable guidance error (the type-only wire form is gone)
 *   - the `"browser"`-condition module is a guidance-throwing stub
 *
 * The in-process tests stamp `globalThis.__ALCHEMY_RUNTIME__` (as any
 * real bridge construction does) — process-global state — so they take
 * the runner's whole-process write lock via `{ exclusive: true }` and
 * restore the flag in `finally`.
 */
import * as browser from "@/Client/browser.ts";
import {
  createClient,
  createEffectClient,
  RpcError,
  RpcPrerenderError,
} from "@/Client/index.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { SERVE_BRIDGE_KEY } from "@/Serve/constants.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
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
        expect(rejection).toBeInstanceOf(RpcError);
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

  it("promise-introspection keys are not RPC methods", () => {
    const backend = createClient(ClientSite);
    expect((backend as any).then).toBeUndefined();
    expect((backend as any).catch).toBeUndefined();
    expect((backend as any).finally).toBeUndefined();
    expect((backend as any).toJSON).toBeUndefined();
  });
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
        // Each call snapshots the thunk synchronously AT CALL TIME —
        // before the dispatch's env/runtime awaits yield to the other
        // call — so concurrent identities never cross.
        const [ra, rb] = await Promise.all([a, b]);
        expect(ra).toBe("first");
        expect(rb).toBe("second");
        // Sequential calls definitely observe the latest ambient value.
        current = "third";
        expect(await backend.whoAmI()).toBe("third");
      }),
    { exclusive: true },
  );
});

describe("serve-shell runtime seam (AWS classes)", () => {
  it(
    "the value form dispatches through the class's shell runtime when one is attached",
    () =>
      restoringRuntimeFlag(async () => {
        // A backend class carrying a cloud-flavored serve shell under
        // SERVE_BRIDGE_KEY — the shape AWS Website classes attach at class
        // construction (lambdaServeBridge). The in-process dispatch must
        // build the runtime THROUGH the shell (Lambda/Node recipe), never
        // the default Cloudflare-flavored bridge.
        const seen: Array<Record<string, unknown>> = [];
        const ShellSite = Object.assign(function ShellSite() {}, {
          "~alchemy/Id": "ShellSite",
          [SERVE_BRIDGE_KEY]: {
            match: () => Promise.resolve(undefined),
            runtime: (_site: object, env: Record<string, unknown>) => {
              seen.push(env);
              return Promise.resolve({
                context: Context.empty(),
                shape: () => ({
                  ping: (n: number) => Effect.succeed(n * 10),
                }),
                telemetry: () => undefined,
              });
            },
          },
        }) as any;

        const backend = createClient(ShellSite, { env: markers }) as any;
        expect(await backend.ping(4)).toBe(40);
        // The shell was consulted with the resolved env (not bypassed).
        expect(seen.length).toBe(1);
        expect(seen[0]?.ALCHEMY_STACK_NAME).toBe("client-test");
      }),
    { exclusive: true, timeout: 60_000 },
  );
});

describe("no backend class, no client", () => {
  it("createClient without a Backend class throws the actionable guidance", () => {
    expect(() => (createClient as any)()).toThrow(/createClient requires/);
    expect(() => (createClient as any)({ headers: {} })).toThrow(/HttpApi/);
  });

  it("createEffectClient without a Backend class throws the same guidance", () => {
    expect(() => (createEffectClient as any)()).toThrow(/HttpApi/);
  });
});

describe('the "browser" condition module', () => {
  it("createClient throws the schema guidance (even with a class)", () => {
    expect(() => (browser.createClient as any)()).toThrow(/HttpApi/);
    expect(() => (browser.createClient as any)(ClientSite)).toThrow(
      /server-only/,
    );
  });

  it("createEffectClient throws the schema guidance", () => {
    expect(() => (browser.createEffectClient as any)()).toThrow(
      /schema you own/,
    );
  });
});
