import type * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ProvisioningService } from "./ProvisioningService.ts";

export interface GetIndividualEnrollmentAttestationMechanismRequest extends Omit<
  dps.GetIndividualEnrollmentAttestationMechanismRequest,
  "dpsName"
> {}

/**
 * Read an individual enrollment's attestation mechanism, including its keys.
 *
 * Binding assigns a custom role (`AzureDpsAttestationDetailsRole`, one per stack) with
 * exactly the data action `Microsoft.Devices/provisioningServices/attestationmechanism/details/action`,
 * on the bound provisioning service only (the built-in Device Provisioning
 * Service Data Reader / Data Contributor roles grant every read / every
 * action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetIndividualEnrollmentAttestationMechanismHttp}.
 *
 * ### Calling GetIndividualEnrollmentAttestationMechanism
 * **Example:** GetIndividualEnrollmentAttestationMechanism from a Function
 * ```typescript
 * // init
 * const dps = yield* Azure.IoT.ProvisioningService("devices");
 * const getIndividualEnrollmentAttestationMechanism = yield* Azure.IoT.GetIndividualEnrollmentAttestationMechanism(dps);
 *
 * // runtime
 * const attestation = yield* getIndividualEnrollmentAttestationMechanism({ id: "device-1" });
 *
 * // layer
 * Effect.provide(Azure.IoT.GetIndividualEnrollmentAttestationMechanismHttp)
 * ```
 *
 * @binding
 * @category IoT
 */
export interface GetIndividualEnrollmentAttestationMechanism extends Binding.Service<
  GetIndividualEnrollmentAttestationMechanism,
  "Azure.IoT.GetIndividualEnrollmentAttestationMechanism",
  (
    service: ProvisioningService,
  ) => Effect.Effect<
    (
      request: GetIndividualEnrollmentAttestationMechanismRequest,
    ) => Effect.Effect<
      dps.AttestationMechanism,
      dps.GetIndividualEnrollmentAttestationMechanismError,
      RuntimeContext
    >
  >
> {}

export const GetIndividualEnrollmentAttestationMechanism =
  Binding.Service<GetIndividualEnrollmentAttestationMechanism>(
    "Azure.IoT.GetIndividualEnrollmentAttestationMechanism",
  );
