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
// TODO(sam): should this be named?
export * from "./profile.ts";

export const providers = Layer.mergeAll(
  Layer.provide(
    Layer.provideMerge(Lambda.functionProvider(), ESBuild.layer()),
    Lambda.client(),
  ),
  Layer.provide(SQS.queueProvider(), SQS.client()),
  Layer.provide(DynamoDB.tableProvider(), DynamoDB.client()),
  Layer.provide(EC2.vpcProvider(), EC2.client()),
);

export const bindings = Layer.mergeAll(
  //
  SQS.sendMessageFromLambdaFunction(),
  SQS.queueEventSourceProvider(),
  DynamoDB.getItemFromLambdaFunction(),
);

export const clients = Layer.mergeAll(
  STS.client(),
  IAM.client(),
  S3.client(),
  SQS.client(),
  Lambda.client(),
  DynamoDB.client(),
  EC2.client(),
);

export const defaultProviders = providers.pipe(
  Layer.provideMerge(bindings),
  Layer.provideMerge(Account.fromIdentity()),
  Layer.provideMerge(clients),
);

export const live = defaultProviders.pipe(
  Layer.provide(Region.fromEnv()),
  Layer.provide(Credentials.fromSSO()),
);

export default live;
