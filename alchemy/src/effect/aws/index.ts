import * as Layer from "effect/Layer";
import * as Account from "./account.ts";
import * as Lambda from "./function.ts";
import * as IAM from "./iam.ts";
import * as Queue from "./queue.ts";
import * as S3 from "./s3.ts";
import * as STS from "./sts.ts";

export * as Account from "./account.ts";
export * as Credentials from "./credentials.ts";
export * as Region from "./region.ts";

export const providers = Layer.merge(
  Layer.provide(Lambda.provider, Lambda.client),
  Layer.provide(Queue.provider, Queue.client),
);

export const clients = Layer.mergeAll(
  STS.client,
  IAM.client,
  S3.client,
  Queue.client,
  Lambda.client,
);

export const defaultProviders = providers.pipe(
  Layer.provideMerge(Account.fromIdentity),
  Layer.provide(clients),
);
