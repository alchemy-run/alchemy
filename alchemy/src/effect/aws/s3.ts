import * as Context from "effect/Context";
import { S3 as S3Client } from "itty-aws/s3";
import { createAWSServiceClientLayer } from "./client.ts";

export class Client extends Context.Tag("AWS::S3::Client")<
  Client,
  S3Client
>() {}

export const client = createAWSServiceClientLayer(Client, S3Client);
