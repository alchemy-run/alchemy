import type * as Credentials from "@distilled.cloud/aws/Credentials";
import type * as SigV4 from "@distilled.cloud/aws/SigV4";
import * as Binding from "alchemy/Binding";
import type { SourceError } from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAmpWorkspaceHttpBinding } from "./BindingHttp.ts";
import type { PrometheusApiError, PrometheusMetricMetadata } from "./PrometheusTypes.ts";
import type { Workspace } from "./Workspace.ts";

export interface GetMetricMetadataRequest {
  /** Restrict metadata to one metric name. */
  metric?: string;
  /** Maximum number of metrics to return. */
  limit?: number;
}

/**
 * Runtime binding for `aps:GetMetricMetadata` — read metric metadata (type,
 * help, unit) from an AMP {@link Workspace}'s Prometheus-compatible
 * `api/v1/metadata` endpoint, SigV4-signed with the host Function's
 * credentials.
 *
 * ### Reading Metric Metadata
 * **Example:** All Metric Metadata
 * ```typescript
 * const getMetricMetadata = yield* AMP.GetMetricMetadata(workspace);
 * const metadata = yield* getMetricMetadata({});
 * // { http_requests_total: [{ type: "counter", help: "...", unit: "" }], ... }
 * ```
 *
 * @binding
 */
export interface GetMetricMetadata extends Binding.Service<
  GetMetricMetadata,
  "AWS.AMP.GetMetricMetadata",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: GetMetricMetadataRequest,
    ) => Effect.Effect<
      Record<string, PrometheusMetricMetadata[]>,
      PrometheusApiError | Credentials.CredentialsError | SourceError | SigV4.SigningError
    >
  >
> {}
export const GetMetricMetadata = Binding.Service<GetMetricMetadata>("AWS.AMP.GetMetricMetadata");

export const GetMetricMetadataHttp = Layer.effect(
  GetMetricMetadata,
  makeAmpWorkspaceHttpBinding({
    name: "GetMetricMetadata",
    iamActions: ["aps:GetMetricMetadata"],
    makeClient: (send) => (request: GetMetricMetadataRequest) =>
      send({
        method: "GET",
        path: "api/v1/metadata",
        query: {
          metric: request.metric,
          limit: request.limit !== undefined ? String(request.limit) : undefined,
        },
      }).pipe(Effect.map((data) => data as Record<string, PrometheusMetricMetadata[]>)),
  }),
);
