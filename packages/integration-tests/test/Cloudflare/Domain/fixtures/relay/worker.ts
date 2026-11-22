import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Hop, Pass, PassOnLive, Relay } from "./relay.ts";

const RelayLive = Relay.layer(PassOnLive).pipe(
  Layer.provide(DomainCloudflare.layerDurableObjects()),
);

/**
 * `POST /start/<chain>/<hops>` sends the first hop; `GET /hop/<chain>/<n>`
 * reads hop `n` (the last hop is 0).
 */
const ROUTE = /^\/(start|hop)\/([^/]+)\/(\d+)$/;

export default class DomainRelayWorker extends Cloudflare.Worker<DomainRelayWorker>()(
  "DomainRelayWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const hops = yield* Hop;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const route = ROUTE.exec(new URL(request.url, "http://localhost").pathname);
        if (!route) return HttpServerResponse.text("Not Found", { status: 404 });
        const [, action, chain, n] = route;
        const left = Number(n);
        if (action === "start") {
          yield* hops.send(new Pass({ id: `${chain}-${left}`, chain: chain!, left }));
          return HttpServerResponse.text("ok");
        }
        return yield* HttpServerResponse.json(yield* hops.get(`${chain}-${left}`));
      }),
    };
  }).pipe(Effect.provide(RelayLive)),
) {}
