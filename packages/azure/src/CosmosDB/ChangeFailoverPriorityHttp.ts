import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import { ChangeFailoverPriority } from "./ChangeFailoverPriority.ts";
import type { DatabaseAccount } from "./DatabaseAccount.ts";

/**
 * Implementation of {@link ChangeFailoverPriority} over the distilled `cosmos_db` ARM
 * operation `DatabaseAccountsFailoverPriorityChange`. Assigns the custom `AzureCosmosDBChangeFailoverPriorityRole` on
 * the account.
 *
 * @layer
 * @provides Azure.CosmosDB.ChangeFailoverPriority
 */
export const ChangeFailoverPriorityHttp = Layer.effect(
  ChangeFailoverPriority,
  makeArmActionBinding({
    tag: "Azure.CosmosDB.ChangeFailoverPriority",
    operation: cosmos.DatabaseAccountsFailoverPriorityChange,
    role: {
      role: "CosmosDBChangeFailoverPriority",
      actions: ["Microsoft.DocumentDB/databaseAccounts/failoverPriorityChange/action"],
    },
    resourceId: (account: DatabaseAccount) => account.accountId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      accountName: id.name("databaseAccounts"),
    }),
  }),
);
