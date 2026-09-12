import * as Cloudflare from "@/Cloudflare/index.ts";
import type { RuntimeContext } from "@/RuntimeContext.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * An isolate-shared computation — the "ensure the schema once per isolate"
 * pattern (`Effect.cached` in a Layer build). The first caller runs it;
 * every concurrent caller awaits the same in-flight result and is woken by
 * the finisher's fiber. The tiny TTL makes every *batch* a fresh race
 * (a plain `Effect.cached` only races on the isolate's first batch).
 */
class SharedGate extends Context.Service<
  SharedGate,
  { readonly wait: Effect.Effect<void> }
>()("SharedGate.Gate") {}

const SharedGateLive = Layer.effect(
  SharedGate,
  Effect.gen(function* () {
    const wait = yield* Effect.cachedWithTTL(
      Effect.sleep("300 millis"),
      "1 millis",
    );
    return { wait };
  }),
);

export type HitResult =
  | {
      readonly ok: true;
      readonly n: number | undefined;
      readonly boots: number;
    }
  | { readonly ok: false; readonly error: string };

/**
 * A Durable Object that touches its own storage right after waking from
 * the shared gate. When several actors of this class race through the
 * gate in one isolate, every actor but the finisher is resumed inside
 * the finisher's task — and its `storage.put` must still land in its
 * OWN actor context.
 *
 * Modular form (`class` + `.make()`): the implementation depends on the
 * Worker-provided `SharedGate`, which only the `.make<Req>()` signature can
 * express. The bridge hands the DO the services captured where the Worker
 * yields the class, so the gate instance IS the Worker's — one per isolate.
 */
export class GatedStore extends Cloudflare.DurableObject<
  GatedStore,
  { hit: (n: number) => Effect.Effect<HitResult, never, RuntimeContext> }
>()("GatedStore") {}

export const GatedStoreLive = GatedStore.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const gate = yield* SharedGate;
    return Effect.gen(function* () {
      // Constructor-time storage I/O: also runs on the shared cold-start
      // build path (every actor awaiting the isolate's first build).
      const boots = ((yield* state.storage.get<number>("boots")) ?? 0) + 1;
      yield* state.storage.put("boots", boots);
      return {
        // Failures are rendered HERE, inside the actor: the RPC boundary
        // would otherwise strip the workerd error underneath the
        // `UnknownError` Effect.tryPromise wraps it in.
        hit: (n: number): Effect.Effect<HitResult, never, RuntimeContext> =>
          Effect.gen(function* () {
            yield* gate.wait;
            yield* state.storage.put("n", n);
            return {
              ok: true as const,
              n: yield* state.storage.get<number>("n"),
              boots,
            };
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.succeed({
                ok: false as const,
                error: Cause.pretty(cause),
              }),
            ),
          ),
      };
    });
  }),
);

export default class SharedGateWorker extends Cloudflare.Worker<SharedGateWorker>()(
  "SharedGateWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const stores = yield* GatedStore;
    const gate = yield* SharedGate;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        // The Worker-side twin: concurrent REQUESTS race through the shared
        // gate, then read their own request-pinned body. The body stream
        // belongs to this request's IoContext exactly like storage belongs
        // to an actor.
        if (url.pathname === "/gated" && request.method === "POST") {
          yield* gate.wait;
          const body = yield* request.text;
          return yield* HttpServerResponse.json({ body });
        }
        if (url.pathname !== "/race") {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        const count = Number(url.searchParams.get("count") ?? "8");
        const results = yield* Effect.all(
          Array.from({ length: count }, (_, i) =>
            stores
              .getByName(`racer-${i}`)
              .hit(i)
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.succeed({
                    ok: false as const,
                    error: `rpc: ${Cause.pretty(cause)}`,
                  }),
                ),
              ),
          ),
          { concurrency: "unbounded" },
        );
        return yield* HttpServerResponse.json({ results });
      }),
    };
  }).pipe(
    // `provideMerge` keeps the gate in the Worker's own context too: the
    // Worker's `/gated` route and every actor race through ONE instance.
    Effect.provide(GatedStoreLive.pipe(Layer.provideMerge(SharedGateLive))),
  ),
) {}
