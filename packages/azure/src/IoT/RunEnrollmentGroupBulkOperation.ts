import type * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ProvisioningService } from "./ProvisioningService.ts";

export interface RunEnrollmentGroupBulkOperationRequest extends Omit<
  dps.EnrollmentGroupRunBulkOperationRequest,
  "dpsName"
> {}

/**
 * Create, update, or delete several enrollment groups in one call.
 *
 * Binding assigns a custom role (`AzureDpsEnrollmentGroupBulkRole`, one per stack) with
 * exactly the data actions `Microsoft.Devices/provisioningServices/enrollmentGroups/write` and `enrollmentGroups/delete`,
 * on the bound provisioning service only (the built-in Device Provisioning
 * Service Data Reader / Data Contributor roles grant every read / every
 * action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RunEnrollmentGroupBulkOperationHttp}.
 *
 * ### Calling RunEnrollmentGroupBulkOperation
 * **Example:** RunEnrollmentGroupBulkOperation from a Function
 * ```typescript
 * // init
 * const dps = yield* Azure.IoT.ProvisioningService("devices");
 * const runEnrollmentGroupBulkOperation = yield* Azure.IoT.RunEnrollmentGroupBulkOperation(dps);
 *
 * // runtime
 * const result = yield* runEnrollmentGroupBulkOperation({ mode: "delete", enrollmentGroups });
 *
 * // layer
 * Effect.provide(Azure.IoT.RunEnrollmentGroupBulkOperationHttp)
 * ```
 *
 * @binding
 * @category IoT
 */
export interface RunEnrollmentGroupBulkOperation extends Binding.Service<
  RunEnrollmentGroupBulkOperation,
  "Azure.IoT.RunEnrollmentGroupBulkOperation",
  (
    service: ProvisioningService,
  ) => Effect.Effect<
    (
      request: RunEnrollmentGroupBulkOperationRequest,
    ) => Effect.Effect<
      dps.BulkEnrollmentGroupOperationResult,
      dps.EnrollmentGroupRunBulkOperationError,
      RuntimeContext
    >
  >
> {}

export const RunEnrollmentGroupBulkOperation = Binding.Service<RunEnrollmentGroupBulkOperation>(
  "Azure.IoT.RunEnrollmentGroupBulkOperation",
);
