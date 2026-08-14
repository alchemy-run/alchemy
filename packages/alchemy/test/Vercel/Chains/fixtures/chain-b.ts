/**
 * Effect-mode side B of the circular invoke pair — see chain-a.ts. B binds
 * `invoke({ LogicalId: "ChainEchoA" })` (the module-cycle-free form).
 *
 * B's props are an EFFECT so the replacement test can rename B's project
 * between deploy cycles: `chainBName.current` is a module-scoped mutable
 * the test file flips before the third deploy (an explicit `name` prop
 * change is a project REPLACEMENT). Props effects are re-evaluated on
 * every deploy in a session, so the flip is picked up without re-importing
 * anything; inside the deployed bundle the holder is `undefined`, which is
 * irrelevant — props there never drive provisioning.
 */
import * as Vercel from "@/Vercel/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const chainBName: { current: string | undefined } = {
  current: undefined,
};

export default class ChainEchoB extends Vercel.Function<ChainEchoB>()(
  "ChainEchoB",
  Effect.sync(() => ({
    main: import.meta.url,
    ...(chainBName.current !== undefined ? { name: chainBName.current } : {}),
  })),
  Effect.gen(function* () {
    // By-id forward reference — resolves through the engine's pre-created
    // stub for ChainEchoA, never through the sibling module.
    const a = yield* Vercel.invoke({ LogicalId: "ChainEchoA" });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/call-a")) {
          const res = yield* a.get("/echo?from=b").pipe(Effect.orDie);
          const body = yield* res.json.pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            fn: "b",
            targetUrl: yield* a.url,
            target: body,
          });
        }
        if (request.url.startsWith("/echo")) {
          return yield* HttpServerResponse.json({
            fn: "b",
            echo: request.url,
          });
        }
        return yield* HttpServerResponse.json({ ok: true, fn: "b" });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(`b failed: ${String(cause)}`, {
              status: 500,
            }),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Vercel.InvokeFunctionHttp)),
) {}
