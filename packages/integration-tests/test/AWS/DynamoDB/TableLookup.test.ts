import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:dynamodb", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "TableLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const table = yield* AWS.DynamoDB.Table("lookup-target", {
      partitionKey: "id",
      attributes: { id: "S" },
    });
    return {
      tableName: table.tableName.as<string>(),
      tableArn: table.tableArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up table resolves by name with its key schema, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { tableName, tableArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const table = AWS.DynamoDB.Table.lookup({ tableName });
          return { arn: table.tableArn, key: table.partitionKey };
        },
        {
          arn: tableArn,
          key: "id",
        },
      );
      const survivor = yield* dynamodb.describeTable({ TableName: tableName });
      expect(survivor.Table?.TableArn).toBe(tableArn);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing table fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-table", {
            value: AWS.DynamoDB.Table.lookup({ tableName: name }).tableArn,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a table this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        AWS.DynamoDB.Table("lookup-managed", { partitionKey: "id", attributes: { id: "S" } });
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-table-consumer", {
              value: AWS.DynamoDB.Table.lookup({ tableName: attrs.tableName }).tableArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
