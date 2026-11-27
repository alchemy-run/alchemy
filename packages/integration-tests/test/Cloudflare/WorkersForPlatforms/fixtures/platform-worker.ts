import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { DispatchNs, OUTBOUND_REF_STACK, OutboundDispatch } from "./shared.ts";

/**
 * Effect-native platform Worker that binds the dispatch namespace via
 * `Cloudflare.WorkersForPlatforms.Get(DispatchNs)` and forwards requests to a
 * user Worker by script name.
 *
 * `GET /dispatch/:scriptName/...` looks up `:scriptName` in the namespace and
 * forwards the trailing path (plus the `x-custom` header) to the user Worker's
 * `Fetcher`, returning its response verbatim.
 */
export default class WfpPlatformWorker extends Cloudflare.Worker<WfpPlatformWorker>()(
  "WfpBindingPlatformWorker",
  { main: import.meta.filename, workersDev: true },
  Effect.gen(function* () {
    const dispatch = yield* Cloudflare.WorkersForPlatforms.Get(DispatchNs);
    // `GET /outbound/:scriptName?tenant=…` and `/outbound-ref/…` dispatch
    // through a binding with an outbound Worker (one this stack deploys, one
    // another stack does) and ask the user Worker to fetch the internet.
    const outbound = {
      outbound: yield* OutboundDispatch,
      "outbound-ref": yield* Cloudflare.WorkersForPlatforms.Get(DispatchNs, {
        outbound: Cloudflare.Worker.ref("WfpRefOutboundWorker", { stack: OUTBOUND_REF_STACK }),
        parameters: ["tenant"],
      }),
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://placeholder");
        const egress = url.pathname.match(/^\/(outbound|outbound-ref)\/([^/]+)$/);
        if (egress) {
          const userWorker = yield* outbound[egress[1] as keyof typeof outbound]
            .get(egress[2]!, {}, { outbound: { tenant: url.searchParams.get("tenant") } })
            .pipe(Effect.orDie);
          return HttpServerResponse.fromWeb(
            yield* Effect.promise(() => userWorker.fetch("https://user-worker/egress")),
          );
        }
        const match = url.pathname.match(/^\/dispatch\/([^/]+)(\/.*)?$/);
        if (!match) {
          return HttpServerResponse.text("platform-worker ok");
        }
        const [, scriptName, rest] = match;
        const userWorker = yield* dispatch.get(scriptName).pipe(Effect.orDie);
        const response = yield* Effect.promise(() =>
          userWorker.fetch(
            new Request(`https://user-worker${rest ?? "/"}`, {
              headers: { "x-custom": request.headers["x-custom"] ?? "" },
            }),
          ),
        );
        return HttpServerResponse.fromWeb(response);
      }),
    };
  }).pipe(Effect.provide(Cloudflare.WorkersForPlatforms.GetBinding)),
) {}
