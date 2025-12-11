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

export const resources = () =>
  Layer.mergeAll(
    DynamoDB.tableProvider(),
    EC2.subnetProvider(),
    EC2.vpcProvider(),
    Lambda.functionProvider(),
    SQS.queueProvider(),
  );

export const bindings = () =>
  Layer.mergeAll(
    DynamoDB.getItemFromLambdaFunction(),
    SQS.queueEventSourceProvider(),
    SQS.sendMessageFromLambdaFunction(),
  );

export const clients = () =>
  Layer.mergeAll(
    DynamoDB.client(),
    EC2.client(),
    IAM.client(),
    Lambda.client(),
    S3.client(),
    SQS.client(),
    // STS.client(),
  );

export const utils = () => Layer.mergeAll(ESBuild.layer());

export const providers = () =>
  resources().pipe(
    Layer.provideMerge(bindings()),
    Layer.provideMerge(clients()),
    Layer.provideMerge(utils()),
    Layer.provideMerge(Account.fromStageConfig()),
    Layer.provideMerge(STS.client()),
    Layer.provideMerge(Credentials.fromStageConfig()),
    Layer.provideMerge(Region.fromStageConfig()),
  );

export default providers;
