import type * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ProvisioningService } from "./ProvisioningService.ts";

export interface DeleteEnrollmentGroupRequest extends Omit<
  dps.DeleteEnrollmentGroupRequest,
  "dpsName"
> {}

/**
 * Delete a DPS enrollment group.
 *
 * Binding assigns a custom role (`AzureDpsEnrollmentGroupDeleteRole`, one per stack) with
 * exactly the data action `Microsoft.Devices/provisioningServices/enrollmentGroups/delete`,
 * on the bound provisioning service only (the built-in Device Provisioning
 * Service Data Reader / Data Contributor roles grant every read / every
 * action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteEnrollmentGroupHttp}.
 *
 * ### Calling DeleteEnrollmentGroup
 * **Example:** DeleteEnrollmentGroup from a Function
 * ```typescript
 * // init
 * const dps = yield* Azure.IoT.ProvisioningService("devices");
 * const deleteEnrollmentGroup = yield* Azure.IoT.DeleteEnrollmentGroup(dps);
 *
 * // runtime
 * yield* deleteEnrollmentGroup({ id: "sensors" });
 *
 * // layer
 * Effect.provide(Azure.IoT.DeleteEnrollmentGroupHttp)
 * ```
 *
 * @binding
 * @category IoT
 */
export interface DeleteEnrollmentGroup extends Binding.Service<
  DeleteEnrollmentGroup,
  "Azure.IoT.DeleteEnrollmentGroup",
  (
    service: ProvisioningService,
  ) => Effect.Effect<
    (
      request: DeleteEnrollmentGroupRequest,
    ) => Effect.Effect<
      dps.DeleteEnrollmentGroupResponse,
      dps.DeleteEnrollmentGroupError,
      RuntimeContext
    >
  >
> {}

export const DeleteEnrollmentGroup = Binding.Service<DeleteEnrollmentGroup>(
  "Azure.IoT.DeleteEnrollmentGroup",
);
