/**
 * Effect-mode side A of the circular invoke pair used by the
 * InvokeReplacement chain (fresh logical ids — the Functions suite owns
 * `InvokeEchoA`/`InvokeEchoB`). A imports B's class and binds
 * `invoke(ChainEchoB)`; B closes the cycle with a `{ LogicalId }` forward
 * reference (see chain-b.ts) so the module/type graph stays acyclic while
 * the RUNTIME invoke topology is fully circular.
 */
import * as Vercel from "@/Vercel/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import ChainEchoB from "./chain-b.ts";

export default class ChainEchoA extends Vercel.Function<ChainEchoA>()(
  "ChainEchoA",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const b = yield* Vercel.invoke(ChainEchoB);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/call-b")) {
          const res = yield* b.get("/echo?from=a").pipe(Effect.orDie);
          const body = yield* res.json.pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            fn: "a",
            targetUrl: yield* b.url,
            target: body,
          });
        }
        if (request.url.startsWith("/echo")) {
          return yield* HttpServerResponse.json({
            fn: "a",
            echo: request.url,
          });
        }
        return yield* HttpServerResponse.json({ ok: true, fn: "a" });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(`a failed: ${String(cause)}`, {
              status: 500,
            }),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Vercel.InvokeFunctionHttp)),
) {}
