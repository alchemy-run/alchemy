import * as Context from "effect/Context";
import { IAM as IAMClient } from "itty-aws/iam";
import { createAWSServiceClientLayer } from "./client.ts";

export class Client extends Context.Tag("AWS::IAM::Client")<
  Client,
  IAMClient
>() {}

export const client = createAWSServiceClientLayer(Client, IAMClient);
