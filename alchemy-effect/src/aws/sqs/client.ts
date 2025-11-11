import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { SQS } from "itty-aws/sqs";
import { createAWSServiceClientLayer } from "../client.ts";
import * as Credentials from "../credentials.ts";
import * as Region from "../region.ts";

export class SQSClient extends Context.Tag("AWS.SQS.Client")<
  SQSClient,
  SQS
>() {}

export const client = createAWSServiceClientLayer<typeof SQSClient, SQS>(
  SQSClient,
  SQS,
);

export const clientFromEnv = () =>
  Layer.provide(client(), Layer.merge(Credentials.fromEnv(), Region.fromEnv()));
