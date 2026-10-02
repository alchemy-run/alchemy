import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  COSMOS_LOCATION,
  logLevel,
  subscriptionId,
  waitGone,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getUser = (
  resourceGroupName: string,
  accountName: string,
  mongoUserDefinitionId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetMongoDBResourceMongoUserDefinition({
      subscriptionId,
      resourceGroupName,
      accountName,
      mongoUserDefinitionId,
    }),
  );

const program = (props: {
  role: "read" | "readWrite";
  password: string;
  userName?: string;
}) =>
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
    const user = yield* Azure.CosmosDB.MongoUserDefinition("Api", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      databaseName: database.databaseName,
      userName: props.userName,
      password: Redacted.make(props.password),
      roles: [{ db: database.databaseName, role: props.role }],
    });
    return { group, account, database, user };
  });

// Serverless MongoDB account: no cost while idle; the account dominates
// the runtime (~2-15 min create + delete).
test.provider(
  "create, update, replace, and delete a Cosmos DB MongoDB user definition",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, database, user } = yield* stack.deploy(
        program({ role: "read", password: "Alchemy-Test-Passw0rd-1" }),
      );
      expect(user.userDefinitionName).toEqual(
        `${database.databaseName}.${user.userName}`,
      );
      const observed = yield* getUser(
        group.resourceGroupName,
        account.accountName,
        user.userDefinitionName,
      );
      expect(observed.properties?.userName).toEqual(user.userName);
      expect(observed.properties?.roles?.map((r) => r.role)).toEqual(["read"]);

      // In-place update: roles and password.
      const updated = yield* stack.deploy(
        program({ role: "readWrite", password: "Alchemy-Test-Passw0rd-2" }),
      );
      expect(updated.user.userDefinitionId).toEqual(user.userDefinitionId);
      const reobserved = yield* getUser(
        group.resourceGroupName,
        account.accountName,
        user.userDefinitionName,
      );
      expect(reobserved.properties?.roles?.map((r) => r.role)).toEqual([
        "readWrite",
      ]);

      // Replacement: a new user name creates a new user and deletes the old.
      const replaced = yield* stack.deploy(
        program({
          role: "readWrite",
          password: "Alchemy-Test-Passw0rd-2",
          userName: "alchemyRenamed",
        }),
      );
      expect(replaced.user.userName).toEqual("alchemyRenamed");
      const renamed = yield* getUser(
        group.resourceGroupName,
        account.accountName,
        replaced.user.userDefinitionName,
      );
      expect(renamed.properties?.userName).toEqual("alchemyRenamed");
      expect(
        yield* waitGone(
          getUser(
            group.resourceGroupName,
            account.accountName,
            user.userDefinitionName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getUser(
            group.resourceGroupName,
            account.accountName,
            replaced.user.userDefinitionName,
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
