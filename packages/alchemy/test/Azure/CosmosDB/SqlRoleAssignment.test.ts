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
    cosmos.GetSqlResourceSqlRoleAssignment({
      subscriptionId,
      resourceGroupName,
      accountName,
      roleAssignmentId,
    }),
  );

const program = (role: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: COSMOS_LOCATION,
    });
    const account = yield* Azure.CosmosDB.DatabaseAccount("Account", {
      resourceGroup: group.resourceGroupName,
      location: COSMOS_LOCATION,
      capabilities: ["EnableServerless"],
      disableLocalAuth: true,
    });
    const database = yield* Azure.CosmosDB.SqlDatabase("App", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("Api", {
      resourceGroup: group.resourceGroupName,
    });
    const assignment = yield* Azure.CosmosDB.SqlRoleAssignment("ApiData", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      roleDefinitionId: role,
      principalId: identity.principalId,
      // The scope must reference an existing database: Cosmos accepts the
      // PUT but silently drops assignments on missing scopes.
      scope: Output.map(database.databaseName, (name) => `/dbs/${name}`),
    });
    return { group, account, database, identity, assignment };
  });

// Serverless account + managed identity: no cost while idle; the account
// dominates the runtime (~5-15 min create + delete).
test.provider(
  "grant, replace, and revoke a Cosmos DB data-plane role",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, database, identity, assignment } =
        yield* stack.deploy(program(Azure.CosmosDB.SqlBuiltInRole.DataReader));
      expect(assignment.roleAssignmentName).toMatch(/^[0-9a-f-]{36}$/);
      expect(assignment.principalId).toEqual(identity.principalId);
      expect(assignment.roleDefinitionId.toLowerCase()).toContain(
        `/sqlroledefinitions/${Azure.CosmosDB.SqlBuiltInRole.DataReader}`,
      );
      const observed = yield* getAssignment(
        group.resourceGroupName,
        account.accountName,
        assignment.roleAssignmentName,
      );
      expect(observed.properties?.principalId).toEqual(identity.principalId);
      expect(observed.properties?.scope?.toLowerCase()).toEqual(
        `${account.accountId}/dbs/${database.databaseName}`.toLowerCase(),
      );

      // Replacement: a different role creates a new assignment.
      const replaced = yield* stack.deploy(
        program(Azure.CosmosDB.SqlBuiltInRole.DataContributor),
      );
      expect(replaced.assignment.roleAssignmentName).not.toEqual(
        assignment.roleAssignmentName,
      );
      const reobserved = yield* getAssignment(
        group.resourceGroupName,
        account.accountName,
        replaced.assignment.roleAssignmentName,
      );
      expect(reobserved.properties?.roleDefinitionId?.toLowerCase()).toContain(
        Azure.CosmosDB.SqlBuiltInRole.DataContributor,
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
    timeout: 1_500_000,
  },
);
