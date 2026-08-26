import type * as gmailpostmastertools from "@distilled.cloud/gcp/gmailpostmastertools_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Domain } from "./Domain.ts";

export interface QueryDomainStatsRequest extends Omit<
  gmailpostmastertools.QueryDomainsDomainStatsRequest,
  "parent"
> {}

/**
 * Runtime binding for Postmaster Tools `domains.domainStats.query`.
 *
 * Bind this operation to a {@link Domain} in a Function/Action init
 * phase. Provide {@link QueryDomainStatsHttp}.
 *
 * ### Querying Domain Stats
 * **Example:** Query spam rate
 * ```typescript
 * const query = yield* GCP.Gmailpostmastertools.QueryDomainStats(domain);
 * const stats = yield* query({
 *   body: {
 *     metricDefinitions: [
 *       { name: "spam", baseMetric: { standardMetric: "SPAM_RATE" } },
 *     ],
 *     timeQuery: {
 *       dateList: { dates: [{ year: 2026, month: 1, day: 1 }] },
 *     },
 *   },
 * });
 * ```
 *
 * @binding
 * @product GCP
 * @category Gmail Postmaster Tools
 */
export interface QueryDomainStats extends Binding.Service<
  QueryDomainStats,
  "GCP.Gmailpostmastertools.QueryDomainStats",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: QueryDomainStatsRequest,
    ) => Effect.Effect<
      gmailpostmastertools.QueryDomainStatsResponse,
      gmailpostmastertools.QueryDomainsDomainStatsError,
      RuntimeContext
    >
  >
> {}

export const QueryDomainStats = Binding.Service<QueryDomainStats>(
  "GCP.Gmailpostmastertools.QueryDomainStats",
);
