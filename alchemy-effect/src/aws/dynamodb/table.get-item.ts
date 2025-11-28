import { Effect } from "effect";
import type { ReturnConsumedCapacity } from "itty-aws/dynamodb";
import { Binding } from "../../binding.ts";
import type { Capability } from "../../capability.ts";
import { toEnvKey } from "../../env.ts";
import { declare, type From, type Policy } from "../../policy.ts";
import { Function } from "../lambda/index.ts";
import { fromAttributeValue } from "./attribute-value.ts";
import { DynamoDBClient } from "./client.ts";
import type { Identifier } from "./expr.ts";
import type { ParseProjectionExpression } from "./projection.ts";
import { Table } from "./table.ts";

export interface GetItemConstraint<
  LeadingKeys extends Policy.AnyOf<any> = Policy.AnyOf<any>,
  Attributes extends Policy.AnyOf<any> = Policy.AnyOf<any>,
  ReturnConsumedCapacity extends Policy.AnyOf<any> = Policy.AnyOf<any>,
> {
  leadingKeys?: LeadingKeys;
  attributes?: Attributes;
  returnConsumedCapacity?: ReturnConsumedCapacity;
}

export interface GetItem<
  T = unknown,
  Constraint extends GetItemConstraint | unknown = unknown,
> extends Capability<"AWS.DynamoDB.GetItem", T, Constraint> {
  Constructor: GetItem;
  Reduce: GetItem<
    this["resource"],
    {
      [k in keyof Capability.Constraint.Simplify<
        this["constraint"]
      >]: Capability.Constraint.Simplify<this["constraint"]>[k];
    }
  >;
}

export const GetItem = Binding<
  <
    T extends Table,
    const LeadingKeys extends Policy.AnyOf<any> = Policy.AnyOf<string>,
    const Attributes extends Policy.AnyOf<any> = never,
    const ReturnConsumedCapacity extends Policy.AnyOf<any> = never,
  >(
    table: T,
    constraint?: GetItemConstraint<
      LeadingKeys,
      Attributes,
      ReturnConsumedCapacity
    >,
  ) => Binding<
    Function,
    GetItem<
      From<T>,
      Policy.Constraint<{
        leadingKeys: LeadingKeys;
        attributes: Attributes;
        returnConsumedCapacity: ReturnConsumedCapacity;
      }>
    >
  >
>(Function, "AWS.DynamoDB.GetItem");

// see: https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazondynamodb.html
export const getItem = <
  T extends Table<string, any>,
  const Key extends Table.Key<T>,
  const ProjectionExpression extends string = never,
  const Capacity extends ReturnConsumedCapacity = never,
>({
  table,
  key,
  projectionExpression,
  returnConsumedCapacity,
}: {
  table: T;
  key: Key;
  projectionExpression?: ProjectionExpression;
  returnConsumedCapacity?: Capacity;
}) =>
  Effect.gen(function* () {
    type Parsed = ParseProjectionExpression<ProjectionExpression>;
    type Attributes = Extract<Parsed[number], Identifier>["name"];
    type LeadingKeys = Extract<Key[T["props"]["partitionKey"]], string>;
    type Constraint = Policy.Constraint<{
      leadingKeys: Policy.AnyOf<LeadingKeys>;
      attributes: Policy.AnyOf<Attributes>;
      returnConsumedCapacity: Policy.AnyOf<Capacity>;
    }>;
    yield* declare<
      GetItem<
        From<T>,
        {
          [k in keyof Constraint]: Constraint[k];
        }
      >
    >();
    const tableNameEnv = toEnvKey(table.id, "TABLE_NAME");
    const tableName = process.env[tableNameEnv];
    if (!tableName) {
      return yield* Effect.die(new Error(`${tableNameEnv} is not set`));
    }
    const ddb = yield* DynamoDBClient;
    const { Item, ...rest } = yield* ddb.getItem({
      TableName: tableName,
      Key: {
        [table.props.partitionKey]: {
          S: (key as any)[table.props.partitionKey] as string,
        },
        ...(table.props.sortKey
          ? {
              [table.props.sortKey]: {
                S: (key as any)[table.props.sortKey] as string,
              },
            }
          : {}),
      },
      ProjectionExpression: projectionExpression,
      ReturnConsumedCapacity: returnConsumedCapacity,
    });

    return {
      ...rest,
      Item: Item
        ? (Object.fromEntries(
            yield* Effect.promise(() =>
              Promise.all(
                Object.entries(Item!).map(async ([key, value]) => [
                  key,
                  await fromAttributeValue(value),
                ]),
              ),
            ),
          ) as InstanceType<T["props"]["items"]> & Key)
        : undefined,
    };
  });

export const getItemFromLambdaFunction = () =>
  GetItem.provider.succeed({
    attach: ({ source: table, props }) => ({
      env: {
        [toEnvKey(table.id, "TABLE_NAME")]: table.attr.tableName,
        [toEnvKey(table.id, "TABLE_ARN")]: table.attr.tableArn,
      },
      policyStatements: [
        {
          Sid: "GetItem",
          Effect: "Allow",
          Action: ["dynamodb:GetItem"],
          Resource: [table.attr.tableArn],
          Condition:
            props?.leadingKeys ||
            props?.attributes ||
            props?.returnConsumedCapacity
              ? {
                  // https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazondynamodb.html#amazondynamodb-dynamodb_LeadingKeys

                  // TODO(sam): add StringLike for prefixes, templates, etc.
                  "ForAllValues:StringEquals": {
                    "dynamodb:LeadingKeys": props.leadingKeys
                      ?.anyOf as string[],
                    "dynamodb:Attributes": props.attributes?.anyOf as string[],
                    "dynamodb:ReturnConsumedCapacity": props
                      .returnConsumedCapacity?.anyOf as string[],
                  },
                }
              : undefined,
        },
      ],
    }),
  });
