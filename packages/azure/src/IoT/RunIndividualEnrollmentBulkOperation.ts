import type * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ProvisioningService } from "./ProvisioningService.ts";

export interface RunIndividualEnrollmentBulkOperationRequest extends Omit<
  dps.IndividualEnrollmentRunBulkOperationRequest,
  "dpsName"
> {}

/**
 * Create, update, or delete several individual enrollments in one call.
 *
 * Binding assigns a custom role (`AzureDpsEnrollmentBulkRole`, one per stack) with
 * exactly the data actions `Microsoft.Devices/provisioningServices/enrollments/write` and `enrollments/delete`,
 * on the bound provisioning service only (the built-in Device Provisioning
 * Service Data Reader / Data Contributor roles grant every read / every
 * action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RunIndividualEnrollmentBulkOperationHttp}.
 *
 * ### Calling RunIndividualEnrollmentBulkOperation
 * **Example:** RunIndividualEnrollmentBulkOperation from a Function
 * ```typescript
 * // init
 * const dps = yield* Azure.IoT.ProvisioningService("devices");
 * const runIndividualEnrollmentBulkOperation = yield* Azure.IoT.RunIndividualEnrollmentBulkOperation(dps);
 *
 * // runtime
 * const result = yield* runIndividualEnrollmentBulkOperation({ mode: "create", enrollments });
 *
 * // layer
 * Effect.provide(Azure.IoT.RunIndividualEnrollmentBulkOperationHttp)
 * ```
 *
 * @binding
 * @category IoT
 */
export interface RunIndividualEnrollmentBulkOperation extends Binding.Service<
  RunIndividualEnrollmentBulkOperation,
  "Azure.IoT.RunIndividualEnrollmentBulkOperation",
  (
    service: ProvisioningService,
  ) => Effect.Effect<
    (
      request: RunIndividualEnrollmentBulkOperationRequest,
    ) => Effect.Effect<
      dps.BulkEnrollmentOperationResult,
      dps.IndividualEnrollmentRunBulkOperationError,
      RuntimeContext
    >
  >
> {}

export const RunIndividualEnrollmentBulkOperation =
  Binding.Service<RunIndividualEnrollmentBulkOperation>(
    "Azure.IoT.RunIndividualEnrollmentBulkOperation",
  );
