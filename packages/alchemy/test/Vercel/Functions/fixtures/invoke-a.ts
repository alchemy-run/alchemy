/**
 * Effect-mode fixture A of the circular InvokeFunction pair: A imports B's
 * class and binds `invoke(B)`; B closes the cycle by referencing A by
 * logical id (see invoke-b.ts) so the module graph — and therefore the
 * type graph — stays acyclic while the RUNTIME invoke topology is fully
 * circular. Exercises the engine's pre-create story: both projects (URLs
 * read back from the assigned production domain, bypass secrets minted)
 * exist before either function deploys.
 */
import * as Vercel from "@/Vercel/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import InvokeEchoB from "./invoke-b.ts";

export default class InvokeEchoA extends Vercel.Function<InvokeEchoA>()(
  "InvokeEchoA",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const b = yield* Vercel.invoke(InvokeEchoB);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/call-b")) {
          // Round trip A → B: hits B's /echo through the bypass-carrying
          // client and reports the runtime-bound target URL.
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
