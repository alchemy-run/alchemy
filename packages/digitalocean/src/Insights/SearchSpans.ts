import type * as DO from "@distilled.cloud/digitalocean";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InsightsOptions, InsightsTokenMissing } from "./InsightsBinding.ts";

/**
 * Searches a region's spans in a time range. Pass a personal access token with the `insights:read` scope; it
 * reaches the host as a secret.
 *
 * **Example:** SearchSpans from an App
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const token = yield* Config.Redacted("INSIGHTS_TOKEN");
 *     const search = yield* DigitalOcean.Insights.SearchSpans({ token });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const found = yield* search({
 *           region: "nyc3",
 *           time_range: { from: { relative: "1h" }, to: { relative: "now" } },
 *         });
 *         return yield* HttpServerResponse.json(found);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Insights.SearchSpansHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Insights
 */
export interface SearchSpans extends Binding.Service<
  SearchSpans,
  "DigitalOcean.Insights.SearchSpans",
  (
    options: InsightsOptions,
  ) => Effect.Effect<
    (
      request: DO.InsightsPostSpansSearchRequest,
    ) => Effect.Effect<
      DO.SpansSearchResponse,
      DO.InsightsPostSpansSearchError | InsightsTokenMissing,
      RuntimeContext
    >
  >
> {}

export const SearchSpans = Binding.Service<SearchSpans>("DigitalOcean.Insights.SearchSpans");
