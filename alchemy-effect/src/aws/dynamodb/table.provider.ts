import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { App, type ProviderService } from "alchemy-effect";
import type { TimeToLiveSpecification } from "itty-aws/dynamodb";
import { createTagger, hasTags } from "../../tags.ts";
import { Account } from "../account.ts";
import { Region } from "../region.ts";
import { isScalarAttributeType, toAttributeType } from "./attribute-value.ts";
import { DynamoDBClient } from "./client.ts";
import { Table, type TableAttrs, type TableProps } from "./table.ts";

export const tableProvider = () =>
  Table.provider.effect(
    // @ts-expect-error
    Effect.gen(function* () {
      const dynamodb = yield* DynamoDBClient;
      const app = yield* App;
      const region = yield* Region;
      const accountId = yield* Account;

      const createTableName = (id: string, props: TableProps) =>
        props.tableName ?? `${app.name}-${id}-${app.stage}`;

      const tagged = yield* createTagger();

      const toKeySchema = (props: TableProps) => [
        {
          AttributeName: props.partitionKey as string,
          KeyType: "HASH" as const,
        },
        ...(props.sortKey
          ? [
              {
                AttributeName: props.sortKey as string,
                KeyType: "RANGE" as const,
              },
            ]
          : []),
      ];

      const toAttributeDefinitions = (props: TableProps) =>
        Object.entries(props.attributes)
          .flatMap(([name, schema]) => {
            const type = toAttributeType(schema);
            if (isScalarAttributeType(type)) {
              // only scalars can be included in the attribute definitions
              return [
                {
                  AttributeName: name,
                  AttributeType: type,
                } as const,
              ];
            } else {
              return [];
            }
          })
          .sort((a, b) => a.AttributeName.localeCompare(b.AttributeName));

      const toAttributeDefinitionsMap = (props: TableProps) =>
        Object.fromEntries(
          toAttributeDefinitions(props).map(
            (def) => [def.AttributeName, def.AttributeType] as const,
          ),
        );

      const resolveTableIfOwned = (id: string, tableName: string) =>
        // if it already exists, let's see if it contains tags indicating we (this app+stage) owns it
        // that would indicate we are in a partial state and can safely take control
        dynamodb.describeTable({ TableName: tableName }).pipe(
          Effect.flatMap((r) =>
            dynamodb
              .listTagsOfResource({
                ResourceArn: r.Table?.TableArn!,
              })
              .pipe(
                Effect.map((tags) => [r, tags.Tags] as const),
                Effect.flatMap(([r, tags]) => {
                  if (hasTags(tagged(id), tags)) {
                    return Effect.succeed(r.Table!);
                  }
                  return Effect.fail(
                    new Error("Table tags do not match expected values"),
                  );
                }),
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
        diff: Effect.fn(function* ({ id, news, olds }) {
          const oldTableName = createTableName(id, olds);
          const newTableName = createTableName(id, news);
          if (oldTableName !== newTableName) {
            // TODO(sam): if the name is hard-coded, REPLACE is impossible - we need a suffix
            return { action: "replace" } as const;
          }

          if (
            olds.partitionKey !== news.partitionKey ||
            olds.sortKey !== news.sortKey
          ) {
            return { action: "replace" } as const;
          }
          const oldAttributeDefinitions = toAttributeDefinitionsMap(olds);
          const newAttributeDefinitions = toAttributeDefinitionsMap(news);
          for (const [name, type] of Object.entries(oldAttributeDefinitions)) {
            // CloudFormation requires that editing an existing AttributeDefinition is a replace
            if (newAttributeDefinitions[name] !== type) {
              return { action: "replace" } as const;
            }
          }

          // TODO(sam):
          // Replacements:
          // 1. if you change ImportSourceSpecification

          return { action: "noop" } as const;
        }),

        create: Effect.fn(function* ({ id, news, session }) {
          const tableName = createTableName(id, news);

          const response = yield* dynamodb
            .createTable({
              TableName: tableName,
              TableClass: news.tableClass,
              KeySchema: toKeySchema(news),
              AttributeDefinitions: toAttributeDefinitions(news),
              BillingMode: news.billingMode ?? "PAY_PER_REQUEST",
              SSESpecification: news.sseSpecification,
              WarmThroughput: news.warmThroughput,
              DeletionProtectionEnabled: news.deletionProtectionEnabled,
              OnDemandThroughput: news.onDemandThroughput,
              ProvisionedThroughput: news.provisionedThroughput,
              // ResourcePolicy: (this should be determined by bindings maybe?)

              // TODO(sam): this should come from Lambda.consume ?
              // TODO(sam): that would require Lambda.consume mutates the Table declaration?
              // StreamSpecification: news.streamSpecification,
              Tags: [
                { Key: "alchemy::app", Value: app.name },
                { Key: "alchemy::stage", Value: app.stage },
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
            tableArn: response.TableArn! as TableAttrs<TableProps>["tableArn"],
            partitionKey: news.partitionKey,
            sortKey: news.sortKey,
          } satisfies TableAttrs<TableProps> as TableAttrs<any>;
        }),

        update: Effect.fn(function* ({ output, news, olds }) {
          yield* dynamodb.updateTable({
            TableName: output.tableName,
            TableClass: news.tableClass,
            AttributeDefinitions: toAttributeDefinitions(news),
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
              // Effect.catchTag("ResourceInUseException", () => Effect.void),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      } satisfies ProviderService<Table<string, TableProps>>;
    }),
  );
