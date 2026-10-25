import type * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ProvisioningService } from "./ProvisioningService.ts";

export interface DeleteIndividualEnrollmentRequest extends Omit<
  dps.DeleteIndividualEnrollmentRequest,
  "dpsName"
> {}

/**
 * Delete a DPS individual enrollment.
 *
 * Binding assigns a custom role (`AzureDpsEnrollmentDeleteRole`, one per stack) with
 * exactly the data action `Microsoft.Devices/provisioningServices/enrollments/delete`,
 * on the bound provisioning service only (the built-in Device Provisioning
 * Service Data Reader / Data Contributor roles grant every read / every
 * action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteIndividualEnrollmentHttp}.
 *
 * ### Calling DeleteIndividualEnrollment
 * **Example:** DeleteIndividualEnrollment from a Function
 * ```typescript
 * // init
 * const dps = yield* Azure.IoT.ProvisioningService("devices");
 * const deleteIndividualEnrollment = yield* Azure.IoT.DeleteIndividualEnrollment(dps);
 *
 * // runtime
 * yield* deleteIndividualEnrollment({ id: "device-1" });
 *
 * // layer
 * Effect.provide(Azure.IoT.DeleteIndividualEnrollmentHttp)
 * ```
 *
 * @binding
 * @category IoT
 */
export interface DeleteIndividualEnrollment extends Binding.Service<
  DeleteIndividualEnrollment,
  "Azure.IoT.DeleteIndividualEnrollment",
  (
    service: ProvisioningService,
  ) => Effect.Effect<
    (
      request: DeleteIndividualEnrollmentRequest,
    ) => Effect.Effect<
      dps.DeleteIndividualEnrollmentResponse,
      dps.DeleteIndividualEnrollmentError,
      RuntimeContext
    >
  >
> {}

export const DeleteIndividualEnrollment = Binding.Service<DeleteIndividualEnrollment>(
  "Azure.IoT.DeleteIndividualEnrollment",
);
