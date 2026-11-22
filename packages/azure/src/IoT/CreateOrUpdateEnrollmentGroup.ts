import type * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ProvisioningService } from "./ProvisioningService.ts";

export interface CreateOrUpdateEnrollmentGroupRequest extends Omit<
  dps.EnrollmentGroupCreateOrUpdateRequest,
  "dpsName"
> {}

/**
 * Create or replace a DPS enrollment group.
 *
 * Binding assigns a custom role (`AzureDpsEnrollmentGroupWriteRole`, one per stack) with
 * exactly the data action `Microsoft.Devices/provisioningServices/enrollmentGroups/write`,
 * on the bound provisioning service only (the built-in Device Provisioning
 * Service Data Reader / Data Contributor roles grant every read / every
 * action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CreateOrUpdateEnrollmentGroupHttp}.
 *
 * ### Calling CreateOrUpdateEnrollmentGroup
 * **Example:** CreateOrUpdateEnrollmentGroup from a Function
 * ```typescript
 * // init
 * const dps = yield* Azure.IoT.ProvisioningService("devices");
 * const createOrUpdateEnrollmentGroup = yield* Azure.IoT.CreateOrUpdateEnrollmentGroup(dps);
 *
 * // runtime
 * yield* createOrUpdateEnrollmentGroup({
 *   id: "sensors",
 *   enrollmentGroupId: "sensors",
 *   attestation: { type: "symmetricKey" },
 * });
 *
 * // layer
 * Effect.provide(Azure.IoT.CreateOrUpdateEnrollmentGroupHttp)
 * ```
 *
 * @binding
 * @category IoT
 */
export interface CreateOrUpdateEnrollmentGroup extends Binding.Service<
  CreateOrUpdateEnrollmentGroup,
  "Azure.IoT.CreateOrUpdateEnrollmentGroup",
  (
    service: ProvisioningService,
  ) => Effect.Effect<
    (
      request: CreateOrUpdateEnrollmentGroupRequest,
    ) => Effect.Effect<dps.EnrollmentGroup, dps.EnrollmentGroupCreateOrUpdateError, RuntimeContext>
  >
> {}

export const CreateOrUpdateEnrollmentGroup = Binding.Service<CreateOrUpdateEnrollmentGroup>(
  "Azure.IoT.CreateOrUpdateEnrollmentGroup",
);
