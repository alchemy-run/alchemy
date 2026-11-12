// src/Api.ts
import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Analytics, Hottest } from "./Data.ts";

/**
 * `GET /hottest?n=3` runs the Hottest endpoint; `GET /status` reads the
 * service's state. The Worker holds its own API key for each binding.
 */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const hottest = yield* ClickHouseCloud.QueryApiEndpoints.RunQueryApiEndpoint(Hottest);
    const getService = yield* ClickHouseCloud.Service.GetService(Analytics);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");

        if (url.pathname === "/hottest") {
          const n = Number(url.searchParams.get("n") ?? "5");
          return yield* HttpServerResponse.json(yield* hottest({ queryVariables: { n } }));
        }

        if (url.pathname === "/status") {
          const service = yield* getService();
          return yield* HttpServerResponse.json({ state: service.state });
        }

        return HttpServerResponse.text("Not found", { status: 404 });
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: String(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ClickHouseCloud.QueryApiEndpoints.RunQueryApiEndpointHttp,
        ClickHouseCloud.Service.GetServiceHttp,
      ),
    ),
  ),
) {}
