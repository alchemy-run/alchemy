import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { SQS as SQSClient } from "itty-aws/sqs";
import { createAWSServiceClientLayer } from "../client.ts";
import * as Credentials from "../credentials.ts";
import * as Region from "../region.ts";

export class QueueClient extends Context.Tag("AWS::SQS::Queue.Client")<
  QueueClient,
  SQSClient
>() {}

export const client = createAWSServiceClientLayer<
  typeof QueueClient,
  SQSClient
>(QueueClient, SQSClient);

export const clientFromEnv = () =>
  Layer.provide(client(), Layer.merge(Credentials.fromEnv(), Region.fromEnv()));
