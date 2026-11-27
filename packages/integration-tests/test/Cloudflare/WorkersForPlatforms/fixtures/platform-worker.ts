import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
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
      "outbound-ref": yield* Cloudflare.WorkersForPlatforms.Get<OutboundParams>(DispatchNs, {
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
          return yield* outbound[egress[1] as keyof typeof outbound]
            .get(egress[2]!, {}, { outbound: outboundValues(url.searchParams) })
            .pipe(
              Effect.flatMap((userWorker) =>
                Effect.tryPromise(() => userWorker.fetch("https://user-worker/egress")),
              ),
              Effect.map(HttpServerResponse.fromWeb),
              // A dispatch that fails answers 500 with the error.
              Effect.catch((error) =>
                HttpServerResponse.json({ error: String(error.message) }, { status: 500 }),
              ),
            );
        }
        // `GET /client/:scriptName` calls the user Worker with an Effect
        // `HttpClient` whose fetch is the dispatched Worker's.
        const viaClient = url.pathname.match(/^\/client\/([^/]+)$/);
        if (viaClient) {
          const userWorker = yield* dispatch.get(viaClient[1]!).pipe(Effect.orDie);
          const body = yield* HttpClient.get("https://user-worker/via-client").pipe(
            Effect.flatMap((res) => res.json),
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, ((input, init) =>
              userWorker.fetch(input as RequestInfo, init as RequestInit)) as typeof fetch),
            Effect.orDie,
          );
          return yield* HttpServerResponse.json(body);
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
