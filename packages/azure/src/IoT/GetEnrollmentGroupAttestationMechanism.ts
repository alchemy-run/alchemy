import type * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ProvisioningService } from "./ProvisioningService.ts";

export interface GetEnrollmentGroupAttestationMechanismRequest extends Omit<
  dps.GetEnrollmentGroupAttestationMechanismRequest,
  "dpsName"
> {}

/**
 * Read an enrollment group's attestation mechanism, including its keys.
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
 * Provide {@link GetEnrollmentGroupAttestationMechanismHttp}.
 *
 * ### Calling GetEnrollmentGroupAttestationMechanism
 * **Example:** GetEnrollmentGroupAttestationMechanism from a Function
 * ```typescript
 * // init
 * const dps = yield* Azure.IoT.ProvisioningService("devices");
 * const getEnrollmentGroupAttestationMechanism = yield* Azure.IoT.GetEnrollmentGroupAttestationMechanism(dps);
 *
 * // runtime
 * const attestation = yield* getEnrollmentGroupAttestationMechanism({ id: "sensors" });
 *
 * // layer
 * Effect.provide(Azure.IoT.GetEnrollmentGroupAttestationMechanismHttp)
 * ```
 *
 * @binding
 * @category IoT
 */
export interface GetEnrollmentGroupAttestationMechanism extends Binding.Service<
  GetEnrollmentGroupAttestationMechanism,
  "Azure.IoT.GetEnrollmentGroupAttestationMechanism",
  (
    service: ProvisioningService,
  ) => Effect.Effect<
    (
      request: GetEnrollmentGroupAttestationMechanismRequest,
    ) => Effect.Effect<
      dps.AttestationMechanism,
      dps.GetEnrollmentGroupAttestationMechanismError,
      RuntimeContext
    >
  >
> {}

export const GetEnrollmentGroupAttestationMechanism =
  Binding.Service<GetEnrollmentGroupAttestationMechanism>(
    "Azure.IoT.GetEnrollmentGroupAttestationMechanism",
  );
