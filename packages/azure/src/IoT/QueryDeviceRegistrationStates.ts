import type * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ProvisioningService } from "./ProvisioningService.ts";

export interface QueryDeviceRegistrationStatesRequest extends Omit<
  dps.DeviceRegistrationStateQueryRequest,
  "dpsName"
> {}

/**
 * List the registration states of an enrollment group's devices (one page).
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
 * Provide {@link QueryDeviceRegistrationStatesHttp}.
 *
 * ### Calling QueryDeviceRegistrationStates
 * **Example:** QueryDeviceRegistrationStates from a Function
 * ```typescript
 * // init
 * const dps = yield* Azure.IoT.ProvisioningService("devices");
 * const queryDeviceRegistrationStates = yield* Azure.IoT.QueryDeviceRegistrationStates(dps);
 *
 * // runtime
 * const states = yield* queryDeviceRegistrationStates({ id: "sensors" });
 *
 * // layer
 * Effect.provide(Azure.IoT.QueryDeviceRegistrationStatesHttp)
 * ```
 *
 * @binding
 * @category IoT
 */
export interface QueryDeviceRegistrationStates extends Binding.Service<
  QueryDeviceRegistrationStates,
  "Azure.IoT.QueryDeviceRegistrationStates",
  (
    service: ProvisioningService,
  ) => Effect.Effect<
    (
      request: QueryDeviceRegistrationStatesRequest,
    ) => Effect.Effect<
      dps.DeviceRegistrationStateQueryResponse,
      dps.DeviceRegistrationStateQueryError,
      RuntimeContext
    >
  >
> {}

export const QueryDeviceRegistrationStates = Binding.Service<QueryDeviceRegistrationStates>(
  "Azure.IoT.QueryDeviceRegistrationStates",
);
