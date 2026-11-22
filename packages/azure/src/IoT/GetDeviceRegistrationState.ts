import type * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ProvisioningService } from "./ProvisioningService.ts";

export interface GetDeviceRegistrationStateRequest extends Omit<
  dps.GetDeviceRegistrationStateRequest,
  "dpsName"
> {}

/**
 * Read a device's registration state.
 *
 * Binding assigns a custom role (`AzureDpsRegistrationStateReadRole`, one per stack) with
 * exactly the data action `Microsoft.Devices/provisioningServices/registrationStates/read`,
 * on the bound provisioning service only (the built-in Device Provisioning
 * Service Data Reader / Data Contributor roles grant every read / every
 * action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetDeviceRegistrationStateHttp}.
 *
 * ### Calling GetDeviceRegistrationState
 * **Example:** GetDeviceRegistrationState from a Function
 * ```typescript
 * // init
 * const dps = yield* Azure.IoT.ProvisioningService("devices");
 * const getDeviceRegistrationState = yield* Azure.IoT.GetDeviceRegistrationState(dps);
 *
 * // runtime
 * const state = yield* getDeviceRegistrationState({ id: "device-1" });
 *
 * // layer
 * Effect.provide(Azure.IoT.GetDeviceRegistrationStateHttp)
 * ```
 *
 * @binding
 * @category IoT
 */
export interface GetDeviceRegistrationState extends Binding.Service<
  GetDeviceRegistrationState,
  "Azure.IoT.GetDeviceRegistrationState",
  (
    service: ProvisioningService,
  ) => Effect.Effect<
    (
      request: GetDeviceRegistrationStateRequest,
    ) => Effect.Effect<
      dps.DeviceRegistrationState,
      dps.GetDeviceRegistrationStateError,
      RuntimeContext
    >
  >
> {}

export const GetDeviceRegistrationState = Binding.Service<GetDeviceRegistrationState>(
  "Azure.IoT.GetDeviceRegistrationState",
);
