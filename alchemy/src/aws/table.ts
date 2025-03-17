import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  type KeySchemaElement,
  ResourceInUseException,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import { ignore } from "../error";
import { type Context, Resource } from "../resource";

export interface TableProps {
  tableName: string;
  partitionKey: {
    name: string;
    type: "S" | "N" | "B";
  };
  sortKey?: {
    name: string;
    type: "S" | "N" | "B";
  };
  billingMode?: "PROVISIONED" | "PAY_PER_REQUEST";
  readCapacity?: number;
  writeCapacity?: number;
  tags?: Record<string, string>;
}

export interface TableOutput extends TableProps {
  id: string; // Same as tableName
  arn: string;
  streamArn?: string;
  tableId: string;
}

export class Table extends Resource(
  "dynamo::Table",
  async (
    ctx: Context<TableOutput>,
    props: TableProps,
  ): Promise<TableOutput> => {
    const client = new DynamoDBClient({});

    if (ctx.event === "delete") {
      await ignore(ResourceNotFoundException.name, () =>
        client.send(
          new DeleteTableCommand({
            TableName: props.tableName,
          }),
        ),
      );

      // Wait for table to be deleted
      let tableDeleted = false;
      while (!tableDeleted) {
        try {
          await client.send(
            new DescribeTableCommand({
              TableName: props.tableName,
            }),
          );
          // If we get here, table still exists
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (error) {
          if (error instanceof ResourceNotFoundException) {
            tableDeleted = true;
          } else {
            throw error;
          }
        }
      }

      return {
        ...props,
        id: props.tableName,
        arn: `arn:aws:dynamodb:${client.config.region}:${process.env.AWS_ACCOUNT_ID}:table/${props.tableName}`,
        tableId: "",
      };
    } else {
      try {
        const attributeDefinitions = [
          {
            AttributeName: props.partitionKey.name,
            AttributeType: props.partitionKey.type,
          },
        ];

        const keySchema: KeySchemaElement[] = [
          {
            AttributeName: props.partitionKey.name,
            KeyType: "HASH",
          },
        ];

        if (props.sortKey) {
          attributeDefinitions.push({
            AttributeName: props.sortKey.name,
            AttributeType: props.sortKey.type,
          });
          keySchema.push({
            AttributeName: props.sortKey.name,
            KeyType: "RANGE",
          });
        }

        await client.send(
          new CreateTableCommand({
            TableName: props.tableName,
            AttributeDefinitions: attributeDefinitions,
            KeySchema: keySchema,
            BillingMode: props.billingMode || "PAY_PER_REQUEST",
            ProvisionedThroughput:
              props.billingMode === "PROVISIONED"
                ? {
                    ReadCapacityUnits: props.readCapacity || 5,
                    WriteCapacityUnits: props.writeCapacity || 5,
                  }
                : undefined,
            Tags: props.tags
              ? Object.entries(props.tags).map(([Key, Value]) => ({
                  Key,
                  Value,
                }))
              : undefined,
          }),
        );

        // Wait for table to be active
        let tableActive = false;
        let tableDescription;
        while (!tableActive) {
          const response = await client.send(
            new DescribeTableCommand({
              TableName: props.tableName,
            }),
          );
          tableActive = response.Table?.TableStatus === "ACTIVE";
          if (tableActive) {
            tableDescription = response.Table;
          } else {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }

        return {
          ...props,
          id: props.tableName,
          arn: tableDescription!.TableArn!,
          streamArn: tableDescription!.LatestStreamArn,
          tableId: tableDescription!.TableId!,
        };
      } catch (error) {
        if (error instanceof ResourceInUseException) {
          // Table already exists, get its details
          const response = await client.send(
            new DescribeTableCommand({
              TableName: props.tableName,
            }),
          );
          return {
            ...props,
            id: props.tableName,
            arn: response.Table!.TableArn!,
            streamArn: response.Table!.LatestStreamArn,
            tableId: response.Table!.TableId!,
          };
        }
        throw error;
      }
    }
  },
) {}
