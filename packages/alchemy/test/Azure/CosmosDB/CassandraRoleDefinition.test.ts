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
    cosmos.GetCassandraResourceCassandraRoleDefinition({
      subscriptionId,
      resourceGroupName,
      accountName,
      roleDefinitionId,
    }),
  );

const READ_METADATA = "Microsoft.DocumentDB/databaseAccounts/readMetadata";
const READ_ROWS =
  "Microsoft.DocumentDB/databaseAccounts/cassandra/containers/entities/read";

const program = (props: { roleName?: string; dataActions: string[] }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: COSMOS_LOCATION,
    });
    const account = yield* Azure.CosmosDB.DatabaseAccount("Account", {
      resourceGroup: group.resourceGroupName,
      location: COSMOS_LOCATION,
      capabilities: ["EnableServerless", "EnableCassandra"],
    });
    const role = yield* Azure.CosmosDB.CassandraRoleDefinition("Reader", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      roleName: props.roleName,
      permissions: [{ dataActions: props.dataActions }],
    });
    return { group, account, role };
  });

// Serverless Cassandra account: no cost while idle; the account dominates
// the runtime (~5-15 min create + delete).
test.provider(
  "create, update, and delete a Cosmos DB Cassandra role definition",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, role } = yield* stack.deploy(
        program({ dataActions: [READ_METADATA] }),
      );
      expect(role.roleDefinitionName).toMatch(/^[0-9a-f-]{36}$/);
      const observed = yield* getRole(
        group.resourceGroupName,
        account.accountName,
        role.roleDefinitionName,
      );
      expect(observed.properties?.roleName).toEqual(role.roleName);
      expect(observed.properties?.permissions?.[0]?.dataActions).toEqual([
        READ_METADATA,
      ]);
      expect(observed.properties?.assignableScopes?.[0]?.toLowerCase()).toEqual(
        account.accountId.toLowerCase(),
      );

      // In-place update: role name and data actions.
      const updated = yield* stack.deploy(
        program({
          roleName: "alchemy-row-reader",
          dataActions: [READ_METADATA, READ_ROWS],
        }),
      );
      expect(updated.role.roleDefinitionName).toEqual(role.roleDefinitionName);
      expect(updated.role.roleName).toEqual("alchemy-row-reader");
      const reobserved = yield* getRole(
        group.resourceGroupName,
        account.accountName,
        role.roleDefinitionName,
      );
      expect(reobserved.properties?.roleName).toEqual("alchemy-row-reader");
      expect(
        [...(reobserved.properties?.permissions?.[0]?.dataActions ?? [])].sort(),
      ).toEqual([READ_METADATA, READ_ROWS].sort());

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
