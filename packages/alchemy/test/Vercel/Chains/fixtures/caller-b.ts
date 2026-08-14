/**
 * Effect-mode downstream caller of the one-way invoke chain: binds
 * `invoke({ LogicalId: "ChainUpstreamA" })` — a by-id forward reference to
 * a Function the STACK PROGRAM declares inline (async mode, variable
 * `name` prop), so the replacement test can rename the upstream project
 * between deploy cycles without touching this fixture. `/call-a` reports
 * the runtime-bound target URL and whether the bypass env var arrived, so
 * the test can observe the re-bound env after the upstream is replaced.
 */
import * as Vercel from "@/Vercel/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default class ChainCallerB extends Vercel.Function<ChainCallerB>()(
  "ChainCallerB",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const a = yield* Vercel.invoke({ LogicalId: "ChainUpstreamA" });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/call-a")) {
          const res = yield* a.get("/echo?from=caller-b").pipe(Effect.orDie);
          const body = yield* res.json.pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            fn: "caller-b",
            targetUrl: yield* a.url,
            // sanitizeKey("ChainUpstreamA") is the identity — the bypass
            // env key the InvokeFunction deploy half binds.
            hasBypass: (process.env.ChainUpstreamA_BYPASS ?? "") !== "",
            target: body,
          });
        }
        return yield* HttpServerResponse.json({ ok: true, fn: "caller-b" });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(`caller-b failed: ${String(cause)}`, {
              status: 500,
            }),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Vercel.InvokeFunctionHttp)),
) {}
