import type * as batch from "@distilled.cloud/azure/batch-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ListApplicationsRequest extends Omit<
  batch.ListApplicationApplicationsRequest,
  "endpoint"
> {}

/**
 * List the applications that compute nodes can use (`GET /applications`, one page per call; only applications with an activated package are listed) from any host.
 *
 * Binding assigns a custom role (`AzureBatchReadApplicationsRole` with exactly the actions `Microsoft.Batch/batchAccounts/read`, `Microsoft.Batch/batchAccounts/applications/read` and `Microsoft.Batch/batchAccounts/applications/versions/read`, one per stack, shared with the other bindings that need it)
 * on the Batch account only. The account must allow Entra ID
 * authentication (`allowedAuthenticationModes` includes `AAD`, the
 * default). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link ListApplicationsHttp}.
 *
 * ### Calling ListApplications
 * **Example:** ListApplications from a Function
 * ```typescript
 * // init
 * const listApplications = yield* Azure.Batch.ListApplications(account);
 *
 * // runtime
 * const page = yield* listApplications();
 * const versions = page.value.map((app) => `${app.id}: ${app.versions.join(", ")}`);
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const listApplications = yield* Azure.Batch.ListApplications(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.ListApplicationsHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface ListApplications extends Binding.Service<
  ListApplications,
  "Azure.Batch.ListApplications",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: ListApplicationsRequest,
    ) => Effect.Effect<
      batch.BatchApplicationListResult,
      batch.ListApplicationApplicationsError,
      RuntimeContext
    >
  >
> {}

export const ListApplications = Binding.Service<ListApplications>("Azure.Batch.ListApplications");
