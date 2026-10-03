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
  mongoRoleDefinitionId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetMongoDBResourceMongoRoleDefinition({
      subscriptionId,
      resourceGroupName,
      accountName,
      mongoRoleDefinitionId,
    }),
  );

const program = (props: { actions: string[]; roleName?: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: COSMOS_LOCATION,
    });
    const account = yield* Azure.CosmosDB.DatabaseAccount("Account", {
      resourceGroup: group.resourceGroupName,
      location: COSMOS_LOCATION,
      kind: "MongoDB",
      capabilities: [
        "EnableServerless",
        "EnableMongo",
        "EnableMongoRoleBasedAccessControl",
      ],
      serverVersion: "4.2",
    });
    const database = yield* Azure.CosmosDB.MongoDatabase("Shop", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
    });
    const role = yield* Azure.CosmosDB.MongoRoleDefinition("Reader", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      databaseName: database.databaseName,
      roleName: props.roleName,
      privileges: [
        { resource: { db: database.databaseName }, actions: props.actions },
      ],
    });
    return { group, account, database, role };
  });

// Serverless MongoDB account: no cost while idle; the account dominates
// the runtime (~2-15 min create + delete).
test.provider(
  "create, update, replace, and delete a Cosmos DB MongoDB role definition",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, database, role } = yield* stack.deploy(
        program({ actions: ["find"] }),
      );
      expect(role.roleDefinitionName).toEqual(
        `${database.databaseName}.${role.roleName}`,
      );
      const observed = yield* getRole(
        group.resourceGroupName,
        account.accountName,
        role.roleDefinitionName,
      );
      expect(observed.properties?.roleName).toEqual(role.roleName);
      expect(observed.properties?.privileges?.[0]?.actions).toEqual(["find"]);

      // In-place update: privileges.
      const updated = yield* stack.deploy(
        program({ actions: ["find", "insert"] }),
      );
      expect(updated.role.roleDefinitionId).toEqual(role.roleDefinitionId);
      const reobserved = yield* getRole(
        group.resourceGroupName,
        account.accountName,
        role.roleDefinitionName,
      );
      expect(
        [...(reobserved.properties?.privileges?.[0]?.actions ?? [])].sort(),
      ).toEqual(["find", "insert"]);

      // Replacement: a new role name creates a new role and deletes the old.
      const replaced = yield* stack.deploy(
        program({ actions: ["find", "insert"], roleName: "alchemyRenamed" }),
      );
      expect(replaced.role.roleName).toEqual("alchemyRenamed");
      const renamed = yield* getRole(
        group.resourceGroupName,
        account.accountName,
        replaced.role.roleDefinitionName,
      );
      expect(renamed.properties?.roleName).toEqual("alchemyRenamed");
      expect(
        yield* waitGone(
          getRole(
            group.resourceGroupName,
            account.accountName,
            role.roleDefinitionName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getRole(
            group.resourceGroupName,
            account.accountName,
            replaced.role.roleDefinitionName,
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
