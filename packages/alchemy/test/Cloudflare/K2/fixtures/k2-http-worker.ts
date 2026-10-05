import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { HttpOrders, Order, produceRoutes } from "./k2-shared.ts";

/**
 * Produces to a K2 stream through its HTTP input with a scoped `K2 Produce`
 * token (`WriteStreamHttp` / `StreamSinkHttp`). Live-only: the HTTP layers
 * mint a real account API token.
 */
export default class K2HttpWorker extends Cloudflare.Worker<K2HttpWorker>()(
  "K2HttpWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const orders = yield* HttpOrders;
    const raw = yield* Cloudflare.K2.WriteStream(orders);
    const typed = yield* Cloudflare.K2.WriteStream(orders, { schema: Order });
    const sink = yield* Cloudflare.K2.StreamSink(orders, { schema: Order });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        return yield* produceRoutes(new URL(request.url, "http://x"), { raw, typed, sink });
      }),
    };
  }).pipe(
    Effect.provide(Layer.mergeAll(Cloudflare.K2.WriteStreamHttp, Cloudflare.K2.StreamSinkHttp)),
  ),
) {}
