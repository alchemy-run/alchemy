import type * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ProvisioningService } from "./ProvisioningService.ts";

export interface QueryIndividualEnrollmentsRequest extends Omit<
  dps.IndividualEnrollmentQueryRequest,
  "dpsName"
> {}

/**
 * Query the service's individual enrollments (one page; pass `xMsContinuation` for the next).
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
 * Provide {@link QueryIndividualEnrollmentsHttp}.
 *
 * ### Calling QueryIndividualEnrollments
 * **Example:** QueryIndividualEnrollments from a Function
 * ```typescript
 * // init
 * const dps = yield* Azure.IoT.ProvisioningService("devices");
 * const queryIndividualEnrollments = yield* Azure.IoT.QueryIndividualEnrollments(dps);
 *
 * // runtime
 * const enrollments = yield* queryIndividualEnrollments({ query: "*" });
 *
 * // layer
 * Effect.provide(Azure.IoT.QueryIndividualEnrollmentsHttp)
 * ```
 *
 * @binding
 * @category IoT
 */
export interface QueryIndividualEnrollments extends Binding.Service<
  QueryIndividualEnrollments,
  "Azure.IoT.QueryIndividualEnrollments",
  (
    service: ProvisioningService,
  ) => Effect.Effect<
    (
      request: QueryIndividualEnrollmentsRequest,
    ) => Effect.Effect<
      dps.IndividualEnrollmentQueryResponse,
      dps.IndividualEnrollmentQueryError,
      RuntimeContext
    >
  >
> {}

export const QueryIndividualEnrollments = Binding.Service<QueryIndividualEnrollments>(
  "Azure.IoT.QueryIndividualEnrollments",
);
