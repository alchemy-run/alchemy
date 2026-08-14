/**
 * Effect-mode fixture B of the circular InvokeFunction pair — see
 * invoke-a.ts. B binds `invoke({ LogicalId: "InvokeEchoA" })`, completing
 * the A↔B cycle by logical-id forward reference instead of importing
 * invoke-a.ts: a mutual class import would make each class's type depend
 * on its own initializer via the sibling's impl (TS7022 → `any`), so the
 * by-id form is the documented way to close a circular pair.
 */
import * as Vercel from "@/Vercel/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default class InvokeEchoB extends Vercel.Function<InvokeEchoB>()(
  "InvokeEchoB",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    // By-id forward reference — resolves through the engine's pre-created
    // stub for InvokeEchoA, never through the sibling module.
    const a = yield* Vercel.invoke({ LogicalId: "InvokeEchoA" });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/call-a")) {
          // Round trip B → A: proves the cycle works in both directions.
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
