import * as Azure from "@/Azure";
import * as Output from "@/Output";
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

const getAssignment = (
  resourceGroupName: string,
  accountName: string,
  roleAssignmentId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetTableResourceTableRoleAssignment({
      subscriptionId,
      resourceGroupName,
      accountName,
      roleAssignmentId,
    }),
  );

const READ_METADATA = "Microsoft.DocumentDB/databaseAccounts/readMetadata";

const program = (role: "Reader" | "Writer") =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: COSMOS_LOCATION,
    });
    const account = yield* Azure.CosmosDB.DatabaseAccount("Account", {
      resourceGroup: group.resourceGroupName,
      location: COSMOS_LOCATION,
      capabilities: ["EnableServerless", "EnableTable"],
    });
    const scoped = yield* Azure.CosmosDB.Table("Sessions", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
    });
    // Both roles stay deployed across the replacement step.
    const reader = yield* Azure.CosmosDB.TableRoleDefinition("Reader", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      permissions: [{ dataActions: [READ_METADATA] }],
    });
    const writer = yield* Azure.CosmosDB.TableRoleDefinition("Writer", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      permissions: [
        {
          dataActions: [
            READ_METADATA,
            "Microsoft.DocumentDB/databaseAccounts/tables/containers/*",
          ],
        },
      ],
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("Api", {
      resourceGroup: group.resourceGroupName,
    });
    const assignment = yield* Azure.CosmosDB.TableRoleAssignment("ApiData", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      roleDefinitionId: (role === "Reader" ? reader : writer).roleDefinitionId,
      principalId: identity.principalId,
      scope: Output.map(
        scoped.tableName,
        (name) => `/dbs/TablesDB/colls/${name}`,
      ),
    });
    return { group, account, scoped, reader, writer, identity, assignment };
  });

// Serverless account + managed identity: no cost while idle; the account
// dominates the runtime (~2-15 min create + delete).
test.provider(
  "grant, replace, and revoke a Cosmos DB Table data-plane role",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, scoped, reader, identity, assignment } =
        yield* stack.deploy(program("Reader"));
      expect(assignment.roleAssignmentName).toMatch(/^[0-9a-f-]{36}$/);
      expect(assignment.principalId).toEqual(identity.principalId);
      expect(assignment.roleDefinitionId.toLowerCase()).toEqual(
        reader.roleDefinitionId.toLowerCase(),
      );
      const observed = yield* getAssignment(
        group.resourceGroupName,
        account.accountName,
        assignment.roleAssignmentName,
      );
      expect(observed.properties?.principalId).toEqual(identity.principalId);
      expect(observed.properties?.scope?.toLowerCase()).toEqual(
        `${account.accountId}/dbs/TablesDB/colls/${scoped.tableName}`.toLowerCase(),
      );

      // Replacement: a different role creates a new assignment.
      const replaced = yield* stack.deploy(program("Writer"));
      expect(replaced.assignment.roleAssignmentName).not.toEqual(
        assignment.roleAssignmentName,
      );
      const reobserved = yield* getAssignment(
        group.resourceGroupName,
        account.accountName,
        replaced.assignment.roleAssignmentName,
      );
      expect(reobserved.properties?.roleDefinitionId?.toLowerCase()).toEqual(
        replaced.writer.roleDefinitionId.toLowerCase(),
      );
      expect(
        yield* waitGone(
          getAssignment(
            group.resourceGroupName,
            account.accountName,
            assignment.roleAssignmentName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getAssignment(
            group.resourceGroupName,
            account.accountName,
            replaced.assignment.roleAssignmentName,
          ),
          60,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:cosmosdb", "live"],
    timeout: 900_000,
  },
);
