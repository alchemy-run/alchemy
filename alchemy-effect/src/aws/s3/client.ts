import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { S3 } from "itty-aws/s3";
import { createAWSServiceClientLayer } from "../client.ts";
import * as Credentials from "../credentials.ts";
import * as Region from "../region.ts";

export class S3Client extends Context.Tag("AWS.S3.Client")<S3Client, S3>() {}

export const client = createAWSServiceClientLayer<typeof S3Client, S3>(
  S3Client,
  S3,
);

export const clientFromEnv = () =>
  Layer.provide(client(), Layer.merge(Credentials.fromEnv(), Region.fromEnv()));
