import * as Layer from "effect/Layer";
import * as Account from "./account.ts";
import * as Credentials from "./credentials.ts";
import * as IAM from "./iam.ts";
import * as Lambda from "./lambda/index.ts";
import * as Region from "./region.ts";
import * as S3 from "./s3.ts";
import * as SQS from "./sqs.ts";
import * as STS from "./sts.ts";

export const providers = Layer.merge(
  Layer.provide(Lambda.functionProvider(), Lambda.client()),
  Layer.provide(SQS.provider(), SQS.client()),
);

export const clients = Layer.mergeAll(
  STS.client(),
  IAM.client(),
  S3.client(),
  SQS.client(),
  Lambda.client(),
);

export const defaultProviders = providers.pipe(
  Layer.provideMerge(Account.fromIdentity()),
  Layer.provide(clients),
);

export const layer = defaultProviders.pipe(
  Layer.provide(Region.fromEnv()),
  Layer.provide(Credentials.fromChain()),
);
