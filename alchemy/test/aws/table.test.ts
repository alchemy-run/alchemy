import {
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy.js";
import { Table } from "../../src/aws/table.js";
import { destroy } from "../../src/destroy.js";
import { BRANCH_PREFIX } from "../util.js";

import "../../src/test/bun.js";

const test = alchemy.test(import.meta);

const dynamo = new DynamoDBClient({});

describe("AWS Resources", () => {
  describe("Table", () => {
    test("create table", async (scope) => {
      const tableName = `${BRANCH_PREFIX}-alchemy-test-create-table`;
      const table = await Table(tableName, {
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
        expect(table.tableName).toBe(tableName);
        expect(table.arn).toMatch(
          new RegExp(`^arn:aws:dynamodb:[a-z0-9-]+:\\d+:table\\/${tableName}$`),
        );
        expect(table.tableId).toBeTruthy();
        expect(table.partitionKey).toEqual({
          name: "id",
          type: "S",
        });
        expect(table.sortKey).toEqual({
          name: "timestamp",
          type: "N",
        });
        expect(table.tags).toEqual({
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
        await destroy(scope);

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
