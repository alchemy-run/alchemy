import type * as lambda from "aws-lambda";

import type * as DynamoDB from "distilled-aws/dynamodb";
import type { TimeToLiveSpecification } from "distilled-aws/dynamodb";
import * as dynamodb from "distilled-aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Resource } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { createInternalTags, hasTags } from "../../Tags.ts";
import type { AccountID } from "../Account.ts";
import type { RegionID } from "../Region.ts";

export type TableName = string;

export type TableArn =
  `arn:aws:dynamodb:${RegionID}:${AccountID}:table/${TableName}`;

export type TableRecord<Data> = Omit<lambda.DynamoDBRecord, "dynamodb"> & {
  dynamodb: Omit<lambda.StreamRecord, "NewImage" | "OldImage"> & {
    NewImage?: Data;
    OldImage?: Data;
  };
};

export type TableEvent<Data> = Omit<lambda.DynamoDBStreamEvent, "Records"> & {
  Records: TableRecord<Data>[];
};

export type ScalarAttributeType = "S" | "N" | "B";

export type TableProps = {
  tableName?: string;
  partitionKey: string;
  sortKey?: string;
  attributes: Record<string, ScalarAttributeType>;
  billingMode?: DynamoDB.BillingMode;
  deletionProtectionEnabled?: boolean;
  onDemandThroughput?: DynamoDB.OnDemandThroughput;
  provisionedThroughput?: DynamoDB.ProvisionedThroughput;
  sseSpecification?: DynamoDB.SSESpecification;
  timeToLiveSpecification?: DynamoDB.TimeToLiveSpecification;
  warmThroughput?: DynamoDB.WarmThroughput;
  tableClass?: DynamoDB.TableClass;
};

export interface Table extends Resource<
  "AWS.DynamoDB.Table",
  TableProps,
  {
    tableId: string;
    tableName: TableName;
    tableArn: TableArn;
    partitionKey: string;
    sortKey: string | undefined;
  }
> {}

export const Table = Resource<Table>("AWS.DynamoDB.Table");

export const TableProvider = () =>
  Table.provider.effect(
    Effect.gen(function* () {
      const stack = yield* Stack;

      const createTableName = (
        id: string,
        props: Input.ResolveProps<TableProps>,
      ) =>
        Effect.gen(function* () {
          return (
            props.tableName ??
            (yield* createPhysicalName({
              id,
              // see: https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TableDescription.html#DDB-Type-TableDescription-TableName
              maxLength: 255,
            }))
          );
        });

      const toKeySchema = (props: Input.ResolveProps<TableProps>) => [
        {
          AttributeName: props.partitionKey,
          KeyType: "HASH" as const,
        },
        ...(props.sortKey
          ? [
              {
                AttributeName: props.sortKey,
                KeyType: "RANGE" as const,
              },
            ]
          : []),
      ];

      const toAttributeDefinitions = (
        attrs: Record<string, ScalarAttributeType>,
      ) =>
        Object.entries(attrs)
          .map(([name, type]) => ({
            AttributeName: name,
            AttributeType: type,
          }))
          .sort((a, b) => a.AttributeName.localeCompare(b.AttributeName));

      const resolveTableIfOwned = (id: string, tableName: string) =>
        // if it already exists, let's see if it contains tags indicating we (this app+stage) owns it
        // that would indicate we are in a partial state and can safely take control
        dynamodb.describeTable({ TableName: tableName }).pipe(
          Effect.flatMap((r) =>
            dynamodb
              .listTagsOfResource({
                // oxlint-disable-next-line no-non-null-asserted-optional-chain
                ResourceArn: r.Table?.TableArn!,
              })
              .pipe(
                Effect.map((tags) => [r, tags.Tags] as const),
                Effect.flatMap(
                  Effect.fn(function* ([r, tags]) {
                    if (hasTags(yield* createInternalTags(id), tags)) {
                      return r.Table!;
                    }
                    return yield* Effect.fail(
                      new Error("Table tags do not match expected values"),
                    );
                  }),
                ),
              ),
          ),
        );

      const updateTimeToLive = (
        tableName: string,
        timeToLiveSpecification: TimeToLiveSpecification,
      ) =>
        dynamodb
          .updateTimeToLive({
            TableName: tableName,
            TimeToLiveSpecification: timeToLiveSpecification!,
          })
          .pipe(
            Effect.retry({
              while: (e) => e.name === "ResourceInUseException",
              schedule: Schedule.exponential(100),
            }),
          );

      return {
        stables: ["tableName", "tableId", "tableArn"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (
            // TODO(sam): if the name is hard-coded, REPLACE is impossible - we need a suffix
            news.tableName !== olds.tableName ||
            olds.partitionKey !== news.partitionKey ||
            olds.sortKey !== news.sortKey
          ) {
            return { action: "replace" } as const;
          }
          for (const [name, type] of Object.entries(olds.attributes)) {
            if (news.attributes[name] !== type) {
              return { action: "replace" } as const;
            }
          }
          // TODO(sam):
          // Replacements:
          // 1. if you change ImportSourceSpecification
        }),

        create: Effect.fn(function* ({ id, news, session }) {
          const tableName = yield* createTableName(id, news);

          const response = yield* dynamodb
            .createTable({
              TableName: tableName,
              TableClass: news.tableClass,
              KeySchema: toKeySchema(news),
              AttributeDefinitions: toAttributeDefinitions(news.attributes),
              BillingMode: news.billingMode ?? "PAY_PER_REQUEST",
              SSESpecification: news.sseSpecification,
              WarmThroughput: news.warmThroughput,
              DeletionProtectionEnabled: news.deletionProtectionEnabled,
              OnDemandThroughput: news.onDemandThroughput,
              ProvisionedThroughput: news.provisionedThroughput,
              Tags: [
                { Key: "alchemy::stack", Value: stack.name },
                { Key: "alchemy::stage", Value: stack.stage },
                { Key: "alchemy::id", Value: id },
              ],
            })
            .pipe(
              Effect.map((r) => r.TableDescription!),
              Effect.retry({
                while: (e) =>
                  e.name === "LimitExceededException" ||
                  e.name === "InternalServerError",
                schedule: Schedule.exponential(100),
              }),
              Effect.catchTag("ResourceInUseException", () =>
                resolveTableIfOwned(id, tableName),
              ),
            );

          if (news.timeToLiveSpecification) {
            yield* updateTimeToLive(tableName, news.timeToLiveSpecification);
          }

          yield* session.note(response.TableArn!);

          return {
            tableName,
            tableId: response.TableId!,
            tableArn: response.TableArn! as TableArn,
            partitionKey: news.partitionKey,
            sortKey: news.sortKey,
          } as const;
        }),

        update: Effect.fn(function* ({ output, news, olds }) {
          yield* dynamodb.updateTable({
            TableName: output.tableName,
            TableClass: news.tableClass,
            AttributeDefinitions: toAttributeDefinitions(news.attributes),
            BillingMode: news.billingMode ?? "PAY_PER_REQUEST",
            SSESpecification: news.sseSpecification,
            WarmThroughput: news.warmThroughput,
            DeletionProtectionEnabled: news.deletionProtectionEnabled,
            OnDemandThroughput: news.onDemandThroughput,
            ProvisionedThroughput: news.provisionedThroughput,

            //
            // StreamSpecification: news.streamSpecification,
            // TimeToLiveSpecification: news.timeToLiveSpecification,

            // TODO(sam): GSIs
            // GlobalSecondaryIndexUpdates

            // TODO(sam): Global Tables
            // MultiRegionConsistency: news.multiRegionConsistency,
            // ReplicaUpdates: [{}]
            // GlobalTableWitnessUpdates: [{Create}]
          });

          if (
            news.timeToLiveSpecification &&
            (news.timeToLiveSpecification.AttributeName !==
              olds.timeToLiveSpecification?.AttributeName ||
              news.timeToLiveSpecification?.Enabled !==
                olds.timeToLiveSpecification?.Enabled)
          ) {
            // TODO(sam): can this run in parallel?
            yield* updateTimeToLive(
              output.tableName,
              news.timeToLiveSpecification,
            );
          }

          return output;
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* dynamodb
            .deleteTable({
              TableName: output.tableName,
            })
            .pipe(
              Effect.timeout(1000),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.retry({
                while: (e) =>
                  e._tag === "ResourceInUseException" ||
                  e._tag === "InternalServerError" ||
                  e._tag === "TimeoutError",
                schedule: Schedule.exponential(100),
              }),
            );

          while (true) {
            const table = yield* dynamodb
              .describeTable({
                TableName: output.tableName,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );

            if (table === undefined) {
              break;
            }
          }
        }),
      };
    }),
  );
