import {
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import { describe, expect, test } from "bun:test";
import { apply } from "../../src/apply";
import { Table } from "../../src/aws/table";
import { destroy } from "../../src/destroy";
import { BRANCH_PREFIX } from "../util";

const dynamo = new DynamoDBClient({});

describe("AWS Resources", () => {
  describe("Table", () => {
    test("create table", async () => {
      const tableName = `${BRANCH_PREFIX}-alchemy-test-create-table`;
      const table = new Table(tableName, {
        tableName,
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

      try {
        const output = await apply(table);
        expect(output.id).toBe(tableName);
        expect(output.arn).toMatch(
          new RegExp(`^arn:aws:dynamodb:[a-z0-9-]+:\\d+:table\\/${tableName}$`),
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
            TableName: tableName,
          }),
        );
        expect(describeResponse.Table?.TableStatus).toBe("ACTIVE");
      } finally {
        // Always clean up, even if test assertions fail
        await destroy(table);

        // Verify table is fully deleted
        await assertTableNotExists(tableName);
      }
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
