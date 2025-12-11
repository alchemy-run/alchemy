export * from "./credentials.ts";
export * from "./profile.ts";

import * as Layer from "effect/Layer";

export { Account } from "./account.ts";
export { Region } from "./region.ts";

// oxlint-disable-next-line no-unused-vars - needed or else provider types are transitively resolved through DynamoDB.Provider<..> lol
import type { Provider } from "../provider.ts";

import * as ESBuild from "../esbuild.ts";
import * as Account from "./account.ts";
import * as Credentials from "./credentials.ts";
import * as DynamoDB from "./dynamodb/index.ts";
import * as EC2 from "./ec2/index.ts";
import * as IAM from "./iam.ts";
import * as Lambda from "./lambda/index.ts";
import * as Region from "./region.ts";
import * as S3 from "./s3.ts";
import * as SQS from "./sqs/index.ts";
import * as STS from "./sts.ts";

import "./config.ts";

const resources = () =>
  Layer.mergeAll(
    Lambda.functionProvider(),
    SQS.queueProvider(),
    DynamoDB.tableProvider(),
    EC2.vpcProvider(),
    EC2.subnetProvider(),
  );

export const bindings = () =>
  Layer.mergeAll(
    SQS.sendMessageFromLambdaFunction(),
    SQS.queueEventSourceProvider(),
    DynamoDB.getItemFromLambdaFunction(),
  );

export const clients = () =>
  Layer.mergeAll(
    STS.client(),
    IAM.client(),
    S3.client(),
    SQS.client(),
    Lambda.client(),
    DynamoDB.client(),
    EC2.client(),
  );

export const utils = () => Layer.mergeAll(ESBuild.layer());

export const providers = () =>
  resources().pipe(
    Layer.provideMerge(bindings()),
    Layer.provideMerge(clients()),
    Layer.provideMerge(
      Layer.mergeAll(
        utils(),
        Region.fromStageConfig(),
        Account.fromStageConfig(),
        Credentials.fromStageConfig(),
      ),
    ),
  );

export default providers;
