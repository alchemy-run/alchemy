import type * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ProvisioningService } from "./ProvisioningService.ts";

export interface GetIndividualEnrollmentRequest extends Omit<
  dps.GetIndividualEnrollmentRequest,
  "dpsName"
> {}

/**
 * Read a DPS individual enrollment.
 *
 * Binding assigns a custom role (`AzureDpsEnrollmentReadRole`, one per stack) with
 * exactly the data action `Microsoft.Devices/provisioningServices/enrollments/read`,
 * on the bound provisioning service only (the built-in Device Provisioning
 * Service Data Reader / Data Contributor roles grant every read / every
 * action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetIndividualEnrollmentHttp}.
 *
 * ### Calling GetIndividualEnrollment
 * **Example:** GetIndividualEnrollment from a Function
 * ```typescript
 * // init
 * const dps = yield* Azure.IoT.ProvisioningService("devices");
 * const getIndividualEnrollment = yield* Azure.IoT.GetIndividualEnrollment(dps);
 *
 * // runtime
 * const enrollment = yield* getIndividualEnrollment({ id: "device-1" });
 *
 * // layer
 * Effect.provide(Azure.IoT.GetIndividualEnrollmentHttp)
 * ```
 *
 * @binding
 * @category IoT
 */
export interface GetIndividualEnrollment extends Binding.Service<
  GetIndividualEnrollment,
  "Azure.IoT.GetIndividualEnrollment",
  (
    service: ProvisioningService,
  ) => Effect.Effect<
    (
      request: GetIndividualEnrollmentRequest,
    ) => Effect.Effect<dps.IndividualEnrollment, dps.GetIndividualEnrollmentError, RuntimeContext>
  >
> {}

export const GetIndividualEnrollment = Binding.Service<GetIndividualEnrollment>(
  "Azure.IoT.GetIndividualEnrollment",
);
