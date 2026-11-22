import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as glue from "@distilled.cloud/aws/glue";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:glue", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "GlueLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const database = yield* AWS.Glue.Database("lookup-target");
    const table = yield* AWS.Glue.Table("lookup-target-table", {
      databaseName: database.databaseName,
    });
    const connection = yield* AWS.Glue.Connection("lookup-target-connection", {
      connectionType: "JDBC",
      connectionProperties: {
        JDBC_CONNECTION_URL: "jdbc:postgresql://db.example.com:5432/lookup",
        USERNAME: "glue",
        PASSWORD: Redacted.make("lookup"),
      },
    });
    return {
      databaseName: database.databaseName.as<string>(),
      databaseArn: database.databaseArn.as<string>(),
      tableName: table.tableName.as<string>(),
      tableArn: table.tableArn.as<string>(),
      connectionName: connection.connectionName.as<string>(),
      connectionArn: connection.connectionArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "databases, tables and connections resolve by name, and survive destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { databaseName, databaseArn, tableName, tableArn, connectionName, connectionArn } =
        yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          return {
            database: AWS.Glue.Database.lookup({ databaseName }).databaseArn,
            table: AWS.Glue.Table.lookup({ databaseName, tableName }).tableArn,
            connection: AWS.Glue.Connection.lookup({ connectionName }).connectionArn,
          };
        },
        {
          database: databaseArn,
          table: tableArn,
          connection: connectionArn,
        },
      );
      const survivor = yield* glue.getDatabase({ Name: databaseName });
      expect(survivor.Database?.Name).toBe(databaseName);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing database or connection fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-database": AWS.Glue.Database.lookup({ databaseName: name }).databaseArn,
        "missing-connection": AWS.Glue.Connection.lookup({ connectionName: name }).connectionArn,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(stack.deploy(AWS.SSM.Parameter(id, { value })), [
          "LookupNotFoundError",
        ]);
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a database this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.Glue.Database("lookup-managed");
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-database-consumer", {
              value: AWS.Glue.Database.lookup({ databaseName: attrs.databaseName }).databaseArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
