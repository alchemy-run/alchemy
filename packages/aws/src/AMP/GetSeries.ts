import type * as Credentials from "@distilled.cloud/aws/Credentials";
import type * as SigV4 from "@distilled.cloud/aws/SigV4";
import * as Binding from "alchemy/Binding";
import type { SourceError } from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAmpWorkspaceHttpBinding, toPromTime } from "./BindingHttp.ts";
import type { PrometheusApiError, PrometheusSeries, PrometheusTime } from "./PrometheusTypes.ts";
import type { Workspace } from "./Workspace.ts";

export interface GetSeriesRequest {
  /** Series selectors — at least one is required, e.g. `['up', 'job:.*']`. */
  match: string[];
  /** Start of the lookup range. A `Date`, Unix seconds, or RFC 3339 string. */
  start?: PrometheusTime;
  /** End of the lookup range. A `Date`, Unix seconds, or RFC 3339 string. */
  end?: PrometheusTime;
}

/**
 * Runtime binding for `aps:GetSeries` — find series (full label sets) that
 * match a selector via an AMP {@link Workspace}'s Prometheus-compatible
 * `api/v1/series` endpoint, SigV4-signed with the host Function's credentials.
 *
 * ### Finding Series
 * **Example:** Match Series by Selector
 * ```typescript
 * const getSeries = yield* AMP.GetSeries(workspace);
 * const series = yield* getSeries({ match: ['{__name__="up"}'] });
 * // [{ __name__: "up", job: "api", instance: "..." }, ...]
 * ```
 *
 * @binding
 */
export interface GetSeries extends Binding.Service<
  GetSeries,
  "AWS.AMP.GetSeries",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: GetSeriesRequest,
    ) => Effect.Effect<
      PrometheusSeries[],
      PrometheusApiError | Credentials.CredentialsError | SourceError | SigV4.SigningError
    >
  >
> {}
export const GetSeries = Binding.Service<GetSeries>("AWS.AMP.GetSeries");

export const GetSeriesHttp = Layer.effect(
  GetSeries,
  makeAmpWorkspaceHttpBinding({
    name: "GetSeries",
    iamActions: ["aps:GetSeries"],
    makeClient: (send) => (request: GetSeriesRequest) =>
      send({
        method: "GET",
        path: "api/v1/series",
        query: {
          "match[]": request.match,
          start: request.start !== undefined ? toPromTime(request.start) : undefined,
          end: request.end !== undefined ? toPromTime(request.end) : undefined,
        },
      }).pipe(Effect.map((data) => data as PrometheusSeries[])),
  }),
);
