import {
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import { describe, expect, test } from "bun:test";
import { apply } from "../../alchemy/src/apply";
import { Table } from "../../alchemy/src/aws/table";
import { destroy } from "../../alchemy/src/destroy";

const dynamo = new DynamoDBClient({});

describe("AWS Resources", () => {
  describe("Table", () => {
    test("create table", async () => {
      const table = new Table("alchemy-test-create-table", {
        tableName: "alchemy-test-create-table",
        partitionKey: {
          name: "id",
          type: "S",
        },
        sortKey: {
          name: "timestamp",
          type: "N",
        },
        tags: {
          Environment: "test",
        },
      });

      const output = await apply(table);
      expect(output.id).toBe("alchemy-test-create-table");
      expect(output.arn).toMatch(
        /^arn:aws:dynamodb:[a-z0-9-]+:\d+:table\/alchemy-test-create-table$/,
      );
      expect(output.tableId).toBeTruthy();
      expect(output.partitionKey).toEqual({
        name: "id",
        type: "S",
      });
      expect(output.sortKey).toEqual({
        name: "timestamp",
        type: "N",
      });
      expect(output.tags).toEqual({
        Environment: "test",
      });

      // Verify table exists and is active
      const describeResponse = await dynamo.send(
        new DescribeTableCommand({
          TableName: "alchemy-test-create-table",
        }),
      );
      expect(describeResponse.Table?.TableStatus).toBe("ACTIVE");

      await destroy(table);

      // Verify table is fully deleted
      await assertTableNotExists("alchemy-test-create-table");
    });
  });
});

async function assertTableNotExists(tableName: string) {
  await expect(
    dynamo.send(
      new DescribeTableCommand({
        TableName: tableName,
      }),
    ),
  ).rejects.toThrow(ResourceNotFoundException);
}
