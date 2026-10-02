import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  COSMOS_LOCATION,
  logLevel,
  subscriptionId,
  waitGone,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRole = (
  resourceGroupName: string,
  accountName: string,
  roleDefinitionId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetSqlResourceSqlRoleDefinition({
      subscriptionId,
      resourceGroupName,
      accountName,
      roleDefinitionId,
    }),
  );

const READ_METADATA = "Microsoft.DocumentDB/databaseAccounts/readMetadata";
const READ_ITEMS =
  "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/read";
const ALL_ITEMS =
  "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/*";

const program = (props: { dataActions: string[]; roleName?: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: COSMOS_LOCATION,
    });
    const account = yield* Azure.CosmosDB.DatabaseAccount("Account", {
      resourceGroup: group.resourceGroupName,
      location: COSMOS_LOCATION,
      capabilities: ["EnableServerless"],
    });
    const role = yield* Azure.CosmosDB.SqlRoleDefinition("ItemReader", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      roleName: props.roleName,
      permissions: [{ dataActions: props.dataActions }],
    });
    return { group, account, role };
  });

// Serverless account: no cost while idle; the account dominates the
// runtime (~5-15 min create + delete).
test.provider(
  "create, update, and delete a Cosmos DB SQL role definition",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, role } = yield* stack.deploy(
        program({ dataActions: [READ_METADATA, READ_ITEMS] }),
      );
      expect(role.roleDefinitionName).toMatch(/^[0-9a-f-]{36}$/);
      expect(role.roleDefinitionId).toContain(
        `/sqlRoleDefinitions/${role.roleDefinitionName}`,
      );
      expect(role.assignableScopes).toHaveLength(1);
      const observed = yield* getRole(
        group.resourceGroupName,
        account.accountName,
        role.roleDefinitionName,
      );
      expect(observed.properties?.type).toEqual("CustomRole");
      expect(observed.properties?.roleName).toEqual(role.roleName);
      expect(
        [...(observed.properties?.permissions?.[0]?.dataActions ?? [])].sort(),
      ).toEqual([READ_METADATA, READ_ITEMS].sort());

      // In-place update: permissions and display name.
      const updated = yield* stack.deploy(
        program({
          dataActions: [READ_METADATA, ALL_ITEMS],
          roleName: "alchemy-item-writer",
        }),
      );
      expect(updated.role.roleDefinitionName).toEqual(role.roleDefinitionName);
      expect(updated.role.roleName).toEqual("alchemy-item-writer");
      const reobserved = yield* getRole(
        group.resourceGroupName,
        account.accountName,
        role.roleDefinitionName,
      );
      expect(reobserved.properties?.roleName).toEqual("alchemy-item-writer");
      expect(
        [
          ...(reobserved.properties?.permissions?.[0]?.dataActions ?? []),
        ].sort(),
      ).toEqual([READ_METADATA, ALL_ITEMS].sort());

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getRole(
            group.resourceGroupName,
            account.accountName,
            role.roleDefinitionName,
          ),
          60,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:cosmosdb", "live"],
    timeout: 1_500_000,
  },
);
