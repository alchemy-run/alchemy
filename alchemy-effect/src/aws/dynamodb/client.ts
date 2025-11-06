import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { DynamoDB } from "itty-aws/dynamodb";
import { createAWSServiceClientLayer } from "../client.ts";
import * as Credentials from "../credentials.ts";
import * as Region from "../region.ts";

export class DynamoDBClient extends Context.Tag("AWS::DynamoDB::Client")<
  DynamoDBClient,
  DynamoDB
>() {}

export const client = createAWSServiceClientLayer<
  typeof DynamoDBClient,
  DynamoDB
>(DynamoDBClient, DynamoDB);

export const clientFromEnv = () =>
  Layer.provide(client(), Layer.merge(Credentials.fromEnv(), Region.fromEnv()));
