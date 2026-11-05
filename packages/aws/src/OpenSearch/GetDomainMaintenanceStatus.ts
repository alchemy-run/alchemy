import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOpenSearchHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for the `GetDomainMaintenanceStatus` operation (IAM action
 * `es:GetDomainMaintenanceStatus`).
 *
 * Reads the status of one in-progress or completed maintenance action started with `StartDomainMaintenance`. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.GetDomainMaintenanceStatusHttp)`.
 * ### Domain Maintenance
 * **Example:** Check a Maintenance Action
 * ```typescript
 * const getDomainMaintenanceStatus = yield* OpenSearch.GetDomainMaintenanceStatus();
 *
 * const result = yield* getDomainMaintenanceStatus({
 *   DomainName: name,
 *   MaintenanceId: maintenanceId,
 * });
 * // result.Status → "COMPLETED"
 * ```
 *
 * @binding
 */
export interface GetDomainMaintenanceStatus extends Binding.Service<
  GetDomainMaintenanceStatus,
  "AWS.OpenSearch.GetDomainMaintenanceStatus",
  () => Effect.Effect<
    (
      request: opensearch.GetDomainMaintenanceStatusRequest,
    ) => Effect.Effect<
      opensearch.GetDomainMaintenanceStatusResponse,
      opensearch.GetDomainMaintenanceStatusError
    >
  >
> {}
export const GetDomainMaintenanceStatus = Binding.Service<GetDomainMaintenanceStatus>(
  "AWS.OpenSearch.GetDomainMaintenanceStatus",
);

export const GetDomainMaintenanceStatusHttp = Layer.effect(
  GetDomainMaintenanceStatus,
  makeOpenSearchHttpBinding({
    tag: "AWS.OpenSearch.GetDomainMaintenanceStatus",
    operation: opensearch.getDomainMaintenanceStatus,
    actions: ["es:GetDomainMaintenanceStatus"],
  }),
);
