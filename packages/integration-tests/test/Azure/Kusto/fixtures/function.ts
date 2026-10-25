import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { accepted } from "../../arm-action-fixture.ts";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

/** The cheapest Dev cluster: stopped and started. */
export const Cluster = Azure.Kusto.Cluster("KustoBindingsCluster");

/**
 * Effect-native Azure Function exercising every Kusto runtime-action binding
 * on a managed-identity host, one route per binding.
 */
export default class KustoFunction extends Azure.Functions.Function<KustoFunction>()(
  "KustoFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const cluster = yield* Cluster;
    const stopCluster = yield* Azure.Kusto.StopCluster(cluster);
    const startCluster = yield* Azure.Kusto.StartCluster(cluster);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        switch (new URL(request.url, "http://localhost").pathname) {
          case "/stop":
            return yield* accepted(stopCluster());
          case "/start":
            return yield* accepted(startCluster());
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(Layer.mergeAll(Azure.Kusto.StopClusterHttp, Azure.Kusto.StartClusterHttp)),
  ),
) {}
