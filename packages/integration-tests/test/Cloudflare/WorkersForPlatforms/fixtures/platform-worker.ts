import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  DispatchNs,
  OUTBOUND_REF_STACK,
  OutboundDispatch,
  type OutboundParams,
  outboundValues,
} from "./shared.ts";

/**
 * Effect-native platform Worker that binds the dispatch namespace via
 * `Cloudflare.WorkersForPlatforms.Get(DispatchNs)` and forwards requests to a
 * user Worker by script name.
 *
 * `GET /dispatch/:scriptName/...` looks up `:scriptName` in the namespace and
 * forwards the trailing path (plus the `x-custom` header) to the user Worker's
 * `Fetcher`, returning its response verbatim.
 *
 * `GET /outbound/:scriptName?tenant=…` dispatches through
 * {@link OutboundDispatch}, a second binding on the same namespace with an
 * outbound Worker, and asks the user Worker to fetch the internet (`/egress`).
 * A dispatch that fails answers 500 with the error.
 *
 * `GET /outbound-ref/:scriptName` does the same through a binding whose outbound
 * Worker another stack deploys (`Cloudflare.Worker.ref`).
 */
export default class WfpPlatformWorker extends Cloudflare.Worker<WfpPlatformWorker>()(
  "WfpBindingPlatformWorker",
  { main: import.meta.filename, workersDev: true },
  Effect.gen(function* () {
    const dispatch = yield* Cloudflare.WorkersForPlatforms.Get(DispatchNs);
    const dispatchOutbound = yield* OutboundDispatch;
    const dispatchRef = yield* Cloudflare.WorkersForPlatforms.Get<OutboundParams>(DispatchNs, {
      outbound: Cloudflare.Worker.ref("WfpRefOutboundWorker", { stack: OUTBOUND_REF_STACK }),
      parameters: ["tenant"],
    });
    const bindings = {
      outbound: dispatchOutbound,
      "outbound-ref": dispatchRef,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://placeholder");
        const outbound = url.pathname.match(/^\/(outbound|outbound-ref)\/([^/]+)$/);
        if (outbound) {
          return yield* bindings[outbound[1] as keyof typeof bindings]
            .get(outbound[2]!, {}, { outbound: outboundValues(url.searchParams) })
            .pipe(
              Effect.flatMap((userWorker) =>
                Effect.tryPromise(() => userWorker.fetch("https://user-worker/egress")),
              ),
              Effect.map(HttpServerResponse.fromWeb),
              Effect.catch((error) =>
                Effect.succeed(
                  HttpServerResponse.text(JSON.stringify({ error: String(error.message) }), {
                    status: 500,
                    contentType: "application/json",
                  }),
                ),
              ),
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
