import type * as Credentials from "@distilled.cloud/aws/Credentials";
import type * as SigV4 from "@distilled.cloud/aws/SigV4";
import * as Binding from "alchemy/Binding";
import type { SourceError } from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAmpWorkspaceHttpBinding, toPromTime } from "./BindingHttp.ts";
import type { PrometheusApiError, PrometheusTime } from "./PrometheusTypes.ts";
import type { Workspace } from "./Workspace.ts";

export interface GetLabelsRequest {
  /** Series selectors restricting which series' labels are returned. */
  match?: string[];
  /** Start of the lookup range. A `Date`, Unix seconds, or RFC 3339 string. */
  start?: PrometheusTime;
  /** End of the lookup range. A `Date`, Unix seconds, or RFC 3339 string. */
  end?: PrometheusTime;
}

export interface GetLabelValuesRequest extends GetLabelsRequest {
  /** Label name to list the values of, e.g. `"__name__"` or `"job"`. */
  label: string;
}

export interface GetLabelsClient {
  /** List label names (`api/v1/labels`). */
  labelNames(
    request?: GetLabelsRequest,
  ): Effect.Effect<
    string[],
    PrometheusApiError | Credentials.CredentialsError | SourceError | SigV4.SigningError
  >;
  /** List the values of one label (`api/v1/label/{name}/values`). */
  labelValues(
    request: GetLabelValuesRequest,
  ): Effect.Effect<
    string[],
    PrometheusApiError | Credentials.CredentialsError | SourceError | SigV4.SigningError
  >;
}

/**
 * Runtime binding for `aps:GetLabels` — list label names and label values
 * from an AMP {@link Workspace}'s Prometheus-compatible query API,
 * SigV4-signed with the host Function's credentials.
 *
 * ### Exploring Labels
 * **Example:** List Label Names
 * ```typescript
 * const labels = yield* AMP.GetLabels(workspace);
 * const names = yield* labels.labelNames();
 * ```
 *
 * **Example:** List Metric Names
 * ```typescript
 * const metricNames = yield* labels.labelValues({ label: "__name__" });
 * ```
 *
 * @binding
 */
export interface GetLabels extends Binding.Service<
  GetLabels,
  "AWS.AMP.GetLabels",
  (workspace: Workspace) => Effect.Effect<GetLabelsClient>
> {}
export const GetLabels = Binding.Service<GetLabels>("AWS.AMP.GetLabels");

const rangeParams = (request: GetLabelsRequest) => ({
  "match[]": request.match,
  start: request.start !== undefined ? toPromTime(request.start) : undefined,
  end: request.end !== undefined ? toPromTime(request.end) : undefined,
});

export const GetLabelsHttp = Layer.effect(
  GetLabels,
  makeAmpWorkspaceHttpBinding({
    name: "GetLabels",
    iamActions: ["aps:GetLabels"],
    makeClient: (send): GetLabelsClient => ({
      labelNames: (request: GetLabelsRequest = {}) =>
        send({
          method: "GET",
          path: "api/v1/labels",
          query: rangeParams(request),
        }).pipe(Effect.map((data) => data as string[])),
      labelValues: (request: GetLabelValuesRequest) =>
        send({
          method: "GET",
          path: `api/v1/label/${encodeURIComponent(request.label)}/values`,
          query: rangeParams(request),
        }).pipe(Effect.map((data) => data as string[])),
    }),
  }),
);
