import type * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ProvisioningService } from "./ProvisioningService.ts";

export interface QueryEnrollmentGroupsRequest extends Omit<
  dps.EnrollmentGroupQueryRequest,
  "dpsName"
> {}

/**
 * Query the service's enrollment groups (one page; pass `xMsContinuation` for the next).
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
 * Provide {@link QueryEnrollmentGroupsHttp}.
 *
 * ### Calling QueryEnrollmentGroups
 * **Example:** QueryEnrollmentGroups from a Function
 * ```typescript
 * // init
 * const dps = yield* Azure.IoT.ProvisioningService("devices");
 * const queryEnrollmentGroups = yield* Azure.IoT.QueryEnrollmentGroups(dps);
 *
 * // runtime
 * const groups = yield* queryEnrollmentGroups({ query: "*" });
 *
 * // layer
 * Effect.provide(Azure.IoT.QueryEnrollmentGroupsHttp)
 * ```
 *
 * @binding
 * @category IoT
 */
export interface QueryEnrollmentGroups extends Binding.Service<
  QueryEnrollmentGroups,
  "Azure.IoT.QueryEnrollmentGroups",
  (
    service: ProvisioningService,
  ) => Effect.Effect<
    (
      request: QueryEnrollmentGroupsRequest,
    ) => Effect.Effect<
      dps.EnrollmentGroupQueryResponse,
      dps.EnrollmentGroupQueryError,
      RuntimeContext
    >
  >
> {}

export const QueryEnrollmentGroups = Binding.Service<QueryEnrollmentGroups>(
  "Azure.IoT.QueryEnrollmentGroups",
);
