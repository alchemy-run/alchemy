export * from "./credentials.ts";
export * from "./profile.ts";

export { Account, type AccountID } from "./account.ts";
export { Region, type RegionID } from "./region.ts";

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

export const providers = () =>
  Layer.mergeAll(
    Layer.provide(Layer.provideMerge(Lambda.functionProvider(), ESBuild.layer()), Lambda.client()),
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
  providers().pipe(
    Layer.provideMerge(bindings()),
    Layer.provideMerge(Account.fromIdentity()),
    Layer.provideMerge(clients()),
  );

export const live = (
  config: { account: Account.AccountID; region: Region.RegionID } = {
    // TODO(sam): error if not set
    account: import.meta.env.AWS_ACCOUNT!,
    region: import.meta.env.AWS_REGION!,
  },
) => defaultProviders().pipe(Layer.provide(Region.fromEnv()), Layer.provide(Credentials.fromSSO()));

export default live;
