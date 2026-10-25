import type * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ProvisioningService } from "./ProvisioningService.ts";

export interface GetEnrollmentGroupRequest extends Omit<dps.GetEnrollmentGroupRequest, "dpsName"> {}

/**
 * Read a DPS enrollment group.
 *
 * Binding assigns a custom role (`AzureDpsEnrollmentGroupReadRole`, one per stack) with
 * exactly the data action `Microsoft.Devices/provisioningServices/enrollmentGroups/read`,
 * on the bound provisioning service only (the built-in Device Provisioning
 * Service Data Reader / Data Contributor roles grant every read / every
 * action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetEnrollmentGroupHttp}.
 *
 * ### Calling GetEnrollmentGroup
 * **Example:** GetEnrollmentGroup from a Function
 * ```typescript
 * // init
 * const dps = yield* Azure.IoT.ProvisioningService("devices");
 * const getEnrollmentGroup = yield* Azure.IoT.GetEnrollmentGroup(dps);
 *
 * // runtime
 * const group = yield* getEnrollmentGroup({ id: "sensors" });
 *
 * // layer
 * Effect.provide(Azure.IoT.GetEnrollmentGroupHttp)
 * ```
 *
 * @binding
 * @category IoT
 */
export interface GetEnrollmentGroup extends Binding.Service<
  GetEnrollmentGroup,
  "Azure.IoT.GetEnrollmentGroup",
  (
    service: ProvisioningService,
  ) => Effect.Effect<
    (
      request: GetEnrollmentGroupRequest,
    ) => Effect.Effect<dps.EnrollmentGroup, dps.GetEnrollmentGroupError, RuntimeContext>
  >
> {}

export const GetEnrollmentGroup = Binding.Service<GetEnrollmentGroup>(
  "Azure.IoT.GetEnrollmentGroup",
);
