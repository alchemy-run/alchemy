/**
 * Unit coverage for the entry-level wrapper seam in `@/Serve/Worker.ts`
 * (pure-local, no cloud):
 *   - `makeWebsiteEntryExports` fetch: verbatim delegation to the
 *     framework-delivered handler — no route gating, no env-marker guard
 *     (route ownership lives inside the framework's composed fetch,
 *     DESIGN §6.2c)
 *   - non-fetch handlers (scheduled/queue) ride the underlying Worker
 *     bridge dispatch: a registered listener receives the event; an
 *     unhandled event type rejects through the bridge, never the framework
 *   - workerd JS-RPC dispatch comes from the bridge proxy: shape methods
 *     resolve, typed failures envelope-encode, unknown methods reject
 *   - `DurableObjectBridge` is a per-class factory over the given base
 *
 * Same process-global discipline as `Serve.test.ts`: `@/Serve/Worker.ts`
 * stamps `globalThis.__ALCHEMY_RUNTIME__` at module evaluation, so every
 * test imports it dynamically under `{ exclusive: true }` and restores the
 * flag in `finally`.
 */
import * as Cloudflare from "@/Cloudflare/index.ts";
import { isWorkerEvent } from "@/Cloudflare/Workers/Worker.ts";
import { ErrorTag } from "@/Rpc.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import type { FunctionContext } from "@/Serverless/Function.ts";
import { describe, expect, it } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const markers = {
  ALCHEMY_STACK_NAME: "serve-entry-test",
  ALCHEMY_STAGE: "test",
};

class EntryTestError extends Data.TaggedError("EntryTestError")<{
  reason: string;
}> {}

/** Controllers observed by `EntrySite`'s scheduled listener. */
const scheduledSeen: unknown[] = [];

class EntrySite extends Cloudflare.Website.Vite<EntrySite>()(
  "ServeEntrySite",
  { main: import.meta.url },
  Effect.gen(function* () {
    // The runtime half of what an event source (e.g. CronEventSourceLive)
    // registers: a scheduled listener on the runtime context. The bridge's
    // non-fetch dispatch must route `worker.scheduled(...)` here. A real
    // event source reaches this seam inside its binding Layer, so the
    // construct's InitReq deliberately excludes RuntimeContext — the cast
    // erases the requirement the bridge satisfies at runtime anyway.
    const ctx =
      (yield* RuntimeContext as unknown as Effect.Effect<unknown>) as FunctionContext;
    yield* ctx.listen((event) => {
      if (!isWorkerEvent(event) || event.type !== "scheduled") return;
      return Effect.sync(() => {
        scheduledSeen.push(event.input);
      });
    });
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("effect-fetch");
      }),
      bump: (n: number) => Effect.succeed(n + 1),
      concat: (a: string, b: string) => Effect.succeed(a + b),
      fail: (reason: string) => Effect.fail(new EntryTestError({ reason })),
      boom: () => Effect.die(new Error("secret internals")),
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

class StubEntrypoint {
  constructor(
    public ctx: any,
    public env: any,
  ) {}
}

const makeCtx = () => ({
  waitUntil: (_promise: Promise<unknown>) => {},
  passThroughOnException: () => {},
});

describe("makeWebsiteEntryExports", () => {
  it(
    "fetch delegates verbatim to the framework-delivered handler",
    () =>
      restoringRuntimeFlag(async () => {
        const { makeWebsiteEntryExports } = await import("@/Serve/Worker.ts");

        const calls: { request: Request; env: unknown; ctx: unknown }[] = [];
        const WebsiteWorker = makeWebsiteEntryExports(StubEntrypoint, {
          site: EntrySite,
          fetch: (request: Request, env: unknown, ctx: unknown) => {
            calls.push({ request, env, ctx });
            return new Response("framework");
          },
        });

        const ctx = makeCtx();
        const worker: any = new WebsiteWorker(ctx, markers);

        // Even an /api path the site's effect fetch could answer goes to
        // the framework handler — the wrapper never route-gates.
        const request = new Request("http://localhost/api/hello");
        const inside: Response = await worker.fetch(request);
        expect(await inside.text()).toBe("framework");
        expect(calls[0]!.request).toBe(request);
        expect(calls[0]!.env).toBe(markers);
        expect(calls[0]!.ctx).toBe(ctx);

        // No env-marker guard either: a marker-less env still delegates
        // (the guard, where needed, lives inside the framework handler).
        const bare: any = new WebsiteWorker(makeCtx(), {});
        const declined: Response = await bare.fetch(
          new Request("http://localhost/api/hello"),
        );
        expect(await declined.text()).toBe("framework");
        expect(calls.length).toBe(2);
      }),
    { exclusive: true },
  );

  it(
    "non-fetch handlers ride the bridge dispatch to registered listeners",
    () =>
      restoringRuntimeFlag(async () => {
        const { makeWebsiteEntryExports } = await import("@/Serve/Worker.ts");

        const WebsiteWorker = makeWebsiteEntryExports(StubEntrypoint, {
          site: EntrySite,
          fetch: () => new Response("framework"),
        });
        const worker: any = new WebsiteWorker(makeCtx(), markers);

        scheduledSeen.length = 0;
        const controller = { scheduledTime: 123, cron: "* * * * *" };
        await worker.scheduled(controller);
        expect(scheduledSeen).toEqual([controller]);

        // An event type with no registered listener rejects through the
        // bridge — proof the wrapper replaced only `fetch` and left the
        // bridge's handler surface intact.
        let queueError: unknown;
        try {
          await worker.queue({ queue: "q", messages: [] });
        } catch (error) {
          queueError = error;
        }
        expect(String(queueError)).toContain(
          "No event handler found for event type 'queue'",
        );
      }),
    { exclusive: true, timeout: 60_000 },
  );

  it(
    "workerd JS-RPC dispatch comes from the underlying bridge proxy",
    () =>
      restoringRuntimeFlag(async () => {
        const { makeWebsiteEntryExports } = await import("@/Serve/Worker.ts");

        const WebsiteWorker = makeWebsiteEntryExports(StubEntrypoint, {
          site: EntrySite,
          fetch: () => new Response("framework"),
        });
        const worker: any = new WebsiteWorker(makeCtx(), markers);

        // Success resolves the raw value (the JS-RPC transport — no HTTP
        // wire, no JSON envelope on success).
        expect(await worker.bump(41)).toBe(42);

        // Positional arguments are applied in order.
        expect(await worker.concat("a", "b")).toBe("ab");

        // Typed failures envelope-encode for the client-side decoder.
        const envelope = await worker.fail("nope");
        expect(envelope._tag).toBe(ErrorTag);
        expect(envelope.error._tag).toBe("EntryTestError");
        expect(envelope.error.reason).toBe("nope");

        // Defects reject with the defect itself — never a failure
        // envelope, so the caller can't mistake a crash for a typed error.
        let boomError: unknown;
        try {
          await worker.boom();
        } catch (error) {
          boomError = error;
        }
        expect(String(boomError)).toContain("secret internals");

        // Unknown methods reject as defects.
        let missingError: unknown;
        try {
          await worker.missing();
        } catch (error) {
          missingError = error;
        }
        expect(String(missingError)).toContain('Method "missing" not found');
      }),
    { exclusive: true, timeout: 60_000 },
  );
});

describe("DurableObjectBridge (wrapper entry)", () => {
  it(
    "returns a per-class factory extending the given base",
    () =>
      restoringRuntimeFlag(async () => {
        const { DurableObjectBridge } = await import("@/Serve/Worker.ts");

        class BaseDO {
          constructor(
            public state: any,
            public env: any,
          ) {}
        }
        const factory = DurableObjectBridge(BaseDO as any, {
          site: EntrySite,
        });
        expect(typeof factory).toBe("function");

        const Counter = factory("Counter");
        expect(Object.getPrototypeOf(Counter)).toBe(BaseDO);

        // Each class name gets its own bridge class over the same base.
        const Other = factory("Other");
        expect(Object.getPrototypeOf(Other)).toBe(BaseDO);
        expect(Other).not.toBe(Counter);
      }),
    { exclusive: true },
  );
});
