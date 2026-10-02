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
    cosmos.GetCassandraResourceCassandraRoleAssignment({
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
      capabilities: ["EnableServerless", "EnableCassandra"],
    });
    const keyspace = yield* Azure.CosmosDB.CassandraKeyspace("App", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("Api", {
      resourceGroup: group.resourceGroupName,
    });
    const assignment = yield* Azure.CosmosDB.CassandraRoleAssignment(
      "ApiData",
      {
        resourceGroup: group.resourceGroupName,
        account: account.accountName,
        roleDefinitionId: role,
        principalId: identity.principalId,
        scope: Output.map(keyspace.keyspaceName, (name) => `/dbs/${name}`),
      },
    );
    return { group, account, keyspace, identity, assignment };
  });

// Serverless Cassandra account + managed identity: no cost while idle; the
// account dominates the runtime (~5-15 min create + delete).
test.provider(
  "grant, replace, and revoke a Cosmos DB Cassandra data-plane role",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, keyspace, identity, assignment } =
        yield* stack.deploy(
          program(Azure.CosmosDB.CassandraBuiltInRole.DataReader),
        );
      expect(assignment.roleAssignmentName).toMatch(/^[0-9a-f-]{36}$/);
      expect(assignment.principalId).toEqual(identity.principalId);
      expect(assignment.roleDefinitionId.toLowerCase()).toContain(
        `/cassandraroledefinitions/${Azure.CosmosDB.CassandraBuiltInRole.DataReader}`,
      );
      const observed = yield* getAssignment(
        group.resourceGroupName,
        account.accountName,
        assignment.roleAssignmentName,
      );
      expect(observed.properties?.principalId).toEqual(identity.principalId);
      expect(observed.properties?.scope?.toLowerCase()).toEqual(
        `${account.accountId}/dbs/${keyspace.keyspaceName}`.toLowerCase(),
      );

      // Replacement: a different role creates a new assignment.
      const replaced = yield* stack.deploy(
        program(Azure.CosmosDB.CassandraBuiltInRole.DataContributor),
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
        Azure.CosmosDB.CassandraBuiltInRole.DataContributor,
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
