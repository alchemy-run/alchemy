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

const get = (
  resourceGroupName: string,
  accountName: string,
  databaseName: string,
  containerName: string,
  name: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetSqlResourceSqlStoredProcedure({
      subscriptionId,
      resourceGroupName,
      accountName,
      databaseName,
      containerName,
      storedProcedureName: name,
    }),
  );

const BODY_V1 = `function hello() {\n  getContext().getResponse().setBody("v1");\n}`;
const BODY_V2 = `function hello() {\n  getContext().getResponse().setBody("v2");\n}`;

const program = (props: { name?: string; body: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: COSMOS_LOCATION,
    });
    const account = yield* Azure.CosmosDB.DatabaseAccount("Account", {
      resourceGroup: group.resourceGroupName,
      location: COSMOS_LOCATION,
      capabilities: ["EnableServerless"],
    });
    const database = yield* Azure.CosmosDB.SqlDatabase("Database", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
    });
    const container = yield* Azure.CosmosDB.SqlContainer("Orders", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      database: database.databaseName,
    });
    const script = yield* Azure.CosmosDB.SqlStoredProcedure("Script", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      database: database.databaseName,
      container: container.containerName,
      name: props.name,
      body: props.body,
    });
    return { group, account, database, container, script };
  });

// Serverless account: no cost while idle; the account dominates the
// runtime (~2-15 min create + delete).
test.provider(
  "create, update, replace, and delete a Cosmos DB stored procedure",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, database, container, script } =
        yield* stack.deploy(program({ body: BODY_V1 }));
      const where = [
        group.resourceGroupName,
        account.accountName,
        database.databaseName,
        container.containerName,
      ] as const;
      expect(script.storedProcedureName).toBeTruthy();
      const observed = yield* get(...where, script.storedProcedureName);
      expect(observed.properties?.resource?.body).toEqual(BODY_V1);

      // In-place update: the body.
      const updated = yield* stack.deploy(program({ body: BODY_V2 }));
      expect(updated.script.storedProcedureName).toEqual(
        script.storedProcedureName,
      );
      const reobserved = yield* get(...where, script.storedProcedureName);
      expect(reobserved.properties?.resource?.body).toEqual(BODY_V2);

      // Replacement: a new name creates a new stored procedure and deletes the old.
      const replaced = yield* stack.deploy(
        program({ name: "alchemyRenamed", body: BODY_V2 }),
      );
      expect(replaced.script.storedProcedureName).toEqual("alchemyRenamed");
      const renamed = yield* get(...where, "alchemyRenamed");
      expect(renamed.properties?.resource?.id).toEqual("alchemyRenamed");
      expect(
        yield* waitGone(get(...where, script.storedProcedureName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(...where, "alchemyRenamed"), 60)).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:cosmosdb", "live"],
    timeout: 900_000,
  },
);
