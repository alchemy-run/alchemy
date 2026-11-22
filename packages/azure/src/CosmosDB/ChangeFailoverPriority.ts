import type * as cosmos from "@distilled.cloud/azure/cosmos_db";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { DatabaseAccount } from "./DatabaseAccount.ts";

export interface ChangeFailoverPriorityRequest extends Omit<
  cosmos.DatabaseAccountsFailoverPriorityChangeRequest,
  "subscriptionId" | "resourceGroupName" | "accountName"
> {}

/**
 * Change the failover priorities of a multi-region Cosmos DB account (`POST
 * …/databaseAccounts/{account}/failoverPriorityChange`); the region given
 * priority 0 becomes the write region (a manual failover).
 *
 * Binding assigns a custom role (`AzureCosmosDBChangeFailoverPriorityRole`,
 * one per stack, shared by every host of this binding) with exactly the action
 * `Microsoft.DocumentDB/databaseAccounts/failoverPriorityChange/action`, on
 * the account only. On a host with a managed identity (an Azure Function,
 * Function App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link ChangeFailoverPriorityHttp}.
 *
 * ### Calling ChangeFailoverPriority
 * **Example:** ChangeFailoverPriority from a Function
 * ```typescript
 * // init
 * const changeFailoverPriority = yield* Azure.CosmosDB.ChangeFailoverPriority(account);
 *
 * // runtime
 * yield* changeFailoverPriority({
 *   failoverPolicies: [
 *     { locationName: "westus2", failoverPriority: 0 },
 *     { locationName: "eastus", failoverPriority: 1 },
 *   ],
 * });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const changeFailoverPriority = yield* Azure.CosmosDB.ChangeFailoverPriority(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.CosmosDB.ChangeFailoverPriorityHttp));
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface ChangeFailoverPriority extends Binding.Service<
  ChangeFailoverPriority,
  "Azure.CosmosDB.ChangeFailoverPriority",
  (
    account: DatabaseAccount,
  ) => Effect.Effect<
    (
      request: ChangeFailoverPriorityRequest,
    ) => Effect.Effect<
      cosmos.DatabaseAccountsFailoverPriorityChangeResponse,
      cosmos.DatabaseAccountsFailoverPriorityChangeError,
      RuntimeContext
    >
  >
> {}

export const ChangeFailoverPriority = Binding.Service<ChangeFailoverPriority>(
  "Azure.CosmosDB.ChangeFailoverPriority",
);
