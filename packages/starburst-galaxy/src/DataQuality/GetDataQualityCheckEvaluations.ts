import type * as dataQuality from "@distilled.cloud/starburst-galaxy/data_quality";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { DataQualityCheck } from "./DataQualityCheck.ts";

/**
 * Read the bound check with every evaluation Galaxy kept: when it ran, on
 * which statistics, and whether it passed.
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** GetDataQualityCheckEvaluations
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 * export const OrdersPresent = StarburstGalaxy.DataQuality.DataQualityCheck("OrdersPresent", {
 *   catalogId: shop.catalogId,
 *   schemaName: "sales",
 *   tableName: "orders",
 *   kind: "QualityExpression",
 *   query: "row_count_min(1)",
 *   severity: "High",
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const getDataQualityCheckEvaluations = yield* StarburstGalaxy.DataQuality.GetDataQualityCheckEvaluations(OrdersPresent);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const history = yield* getDataQualityCheckEvaluations();
 *         return yield* HttpServerResponse.json(history.evaluations.map((e) => e.status));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.DataQuality.GetDataQualityCheckEvaluationsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product DataQuality
 */
export interface GetDataQualityCheckEvaluations extends Binding.Service<
  GetDataQualityCheckEvaluations,
  "StarburstGalaxy.DataQuality.GetDataQualityCheckEvaluations",
  (
    check: DataQualityCheck,
  ) => Effect.Effect<
    () => Effect.Effect<
      dataQuality.DataQualityCheckWithEvaluations,
      dataQuality.GetDataQualityCheckEvaluationsError,
      RuntimeContext
    >
  >
> {}

export const GetDataQualityCheckEvaluations = Binding.Service<GetDataQualityCheckEvaluations>(
  "StarburstGalaxy.DataQuality.GetDataQualityCheckEvaluations",
);
