import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Cloudflare from "@/Cloudflare/index.ts";

/** Streams, schemas, and route helpers shared by the K2 Worker fixtures. */

export const Order = Schema.Struct({
  run: Schema.String,
  index: Schema.Number,
});
export type Order = typeof Order.Type;

/** Worker-binding input only (the default). */
export const BindingOrders = Cloudflare.K2.Stream("K2BindingOrders");

/** HTTP input enabled for the `*Http` producer layers. */
export const HttpOrders = Cloudflare.K2.Stream("K2HttpOrders", { http: true });

const params = (url: URL) => ({
  run: url.searchParams.get("run") ?? "default",
  count: Number(url.searchParams.get("count") ?? "1"),
});

const failed = (error: { _tag: string; message?: string }) =>
  HttpServerResponse.json({ error: error._tag, message: error.message }, { status: 500 });

/**
 * Producer routes over a raw client, a schema-typed client, and a typed
 * sink: `POST /raw|/typed|/sink?run=R&count=N`.
 */
export const produceRoutes = (
  url: URL,
  clients: {
    raw: Cloudflare.K2.WriteStreamClient<Cloudflare.K2.Record>;
    typed: Cloudflare.K2.WriteStreamClient<Order>;
    sink: Cloudflare.K2.StreamSinkClient<Order>;
  },
) =>
  Effect.gen(function* () {
    const { run, count } = params(url);
    const orders = Array.from({ length: count }, (_, index): Order => ({ run, index }));
    const sent =
      url.pathname === "/raw"
        ? clients.raw.send(
            orders.map((order) => ({
              content: `${order.run}:${order.index}`,
              headers: { run: order.run },
            })),
          )
        : url.pathname === "/typed"
          ? clients.typed.send(orders)
          : url.pathname === "/sink"
            ? Stream.fromIterable(orders).pipe(Stream.run(clients.sink))
            : undefined;
    if (sent === undefined) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    return yield* sent.pipe(
      Effect.flatMap(() => HttpServerResponse.json({ produced: count }, { status: 202 })),
      Effect.catch((error) => failed(error)),
    );
  });
