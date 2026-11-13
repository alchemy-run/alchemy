import type * as DO from "@distilled.cloud/digitalocean";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InsightsOptions, InsightsTokenMissing } from "./InsightsBinding.ts";

/**
 * Searches a region's logs in a time range, with an optional filter. Pass a personal access token with the `insights:read` scope; it
 * reaches the host as a secret.
 *
 * **Example:** SearchLogs from an App
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const token = yield* Config.Redacted("INSIGHTS_TOKEN");
 *     const search = yield* DigitalOcean.Insights.SearchLogs({ token });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const logs = yield* search({
 *           region: "nyc3",
 *           time_range: { from: { relative: "1h" }, to: { relative: "now" } },
 *         });
 *         return yield* HttpServerResponse.json(logs);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Insights.SearchLogsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Insights
 */
export interface SearchLogs extends Binding.Service<
  SearchLogs,
  "DigitalOcean.Insights.SearchLogs",
  (
    options: InsightsOptions,
  ) => Effect.Effect<
    (
      request: DO.InsightsPostLogsSearchRequest,
    ) => Effect.Effect<
      DO.LogsSearchResponse,
      DO.InsightsPostLogsSearchError | InsightsTokenMissing,
      RuntimeContext
    >
  >
> {}

export const SearchLogs = Binding.Service<SearchLogs>("DigitalOcean.Insights.SearchLogs");
