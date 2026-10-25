import type * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ProvisioningService } from "./ProvisioningService.ts";

export interface CreateOrUpdateIndividualEnrollmentRequest extends Omit<
  dps.IndividualEnrollmentCreateOrUpdateRequest,
  "dpsName"
> {}

/**
 * Create or replace a DPS individual enrollment.
 *
 * Binding assigns a custom role (`AzureDpsEnrollmentWriteRole`, one per stack) with
 * exactly the data action `Microsoft.Devices/provisioningServices/enrollments/write`,
 * on the bound provisioning service only (the built-in Device Provisioning
 * Service Data Reader / Data Contributor roles grant every read / every
 * action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CreateOrUpdateIndividualEnrollmentHttp}.
 *
 * ### Calling CreateOrUpdateIndividualEnrollment
 * **Example:** CreateOrUpdateIndividualEnrollment from a Function
 * ```typescript
 * // init
 * const dps = yield* Azure.IoT.ProvisioningService("devices");
 * const createOrUpdateIndividualEnrollment = yield* Azure.IoT.CreateOrUpdateIndividualEnrollment(dps);
 *
 * // runtime
 * yield* createOrUpdateIndividualEnrollment({
 *   id: "device-1",
 *   registrationId: "device-1",
 *   attestation: { type: "symmetricKey" },
 * });
 *
 * // layer
 * Effect.provide(Azure.IoT.CreateOrUpdateIndividualEnrollmentHttp)
 * ```
 *
 * @binding
 * @category IoT
 */
export interface CreateOrUpdateIndividualEnrollment extends Binding.Service<
  CreateOrUpdateIndividualEnrollment,
  "Azure.IoT.CreateOrUpdateIndividualEnrollment",
  (
    service: ProvisioningService,
  ) => Effect.Effect<
    (
      request: CreateOrUpdateIndividualEnrollmentRequest,
    ) => Effect.Effect<
      dps.IndividualEnrollment,
      dps.IndividualEnrollmentCreateOrUpdateError,
      RuntimeContext
    >
  >
> {}

export const CreateOrUpdateIndividualEnrollment =
  Binding.Service<CreateOrUpdateIndividualEnrollment>(
    "Azure.IoT.CreateOrUpdateIndividualEnrollment",
  );
