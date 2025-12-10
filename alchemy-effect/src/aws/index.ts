export * from "./credentials.ts";
export * from "./profile.ts";

export { Account } from "./account.ts";
export { Region } from "./region.ts";

import * as Layer from "effect/Layer";
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
    Layer.provide(
      Layer.provideMerge(Lambda.functionProvider(), ESBuild.layer()),
      Lambda.client(),
    ),
    Layer.provideMerge(SQS.queueProvider(), SQS.client()),
    Layer.provideMerge(DynamoDB.tableProvider(), DynamoDB.client()),
    Layer.provideMerge(EC2.vpcProvider(), EC2.client()),
    Layer.provideMerge(EC2.subnetProvider(), EC2.client()),
  );

export const bindings = () =>
  Layer.mergeAll(
    //
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

export const defaultProviders = () =>
  resources().pipe(
    Layer.provideMerge(bindings()),
    Layer.provideMerge(Account.fromIdentity()),
    Layer.provideMerge(clients()),
  );

export const providers = () =>
  defaultProviders().pipe(
    Layer.provide(Region.fromStageConfig()),
    Layer.provide(Credentials.fromSSO()),
  );

export default providers;
