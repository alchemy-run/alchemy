import type * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ProvisioningService } from "./ProvisioningService.ts";

export interface DeleteDeviceRegistrationStateRequest extends Omit<
  dps.DeleteDeviceRegistrationStateRequest,
  "dpsName"
> {}

/**
 * Delete a device's registration state so it registers afresh.
 *
 * Binding assigns a custom role (`AzureDpsRegistrationStateDeleteRole`, one per stack) with
 * exactly the data action `Microsoft.Devices/provisioningServices/registrationStates/delete`,
 * on the bound provisioning service only (the built-in Device Provisioning
 * Service Data Reader / Data Contributor roles grant every read / every
 * action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteDeviceRegistrationStateHttp}.
 *
 * ### Calling DeleteDeviceRegistrationState
 * **Example:** DeleteDeviceRegistrationState from a Function
 * ```typescript
 * // init
 * const dps = yield* Azure.IoT.ProvisioningService("devices");
 * const deleteDeviceRegistrationState = yield* Azure.IoT.DeleteDeviceRegistrationState(dps);
 *
 * // runtime
 * yield* deleteDeviceRegistrationState({ id: "device-1" });
 *
 * // layer
 * Effect.provide(Azure.IoT.DeleteDeviceRegistrationStateHttp)
 * ```
 *
 * @binding
 * @category IoT
 */
export interface DeleteDeviceRegistrationState extends Binding.Service<
  DeleteDeviceRegistrationState,
  "Azure.IoT.DeleteDeviceRegistrationState",
  (
    service: ProvisioningService,
  ) => Effect.Effect<
    (
      request: DeleteDeviceRegistrationStateRequest,
    ) => Effect.Effect<
      dps.DeleteDeviceRegistrationStateResponse,
      dps.DeleteDeviceRegistrationStateError,
      RuntimeContext
    >
  >
> {}

export const DeleteDeviceRegistrationState = Binding.Service<DeleteDeviceRegistrationState>(
  "Azure.IoT.DeleteDeviceRegistrationState",
);
