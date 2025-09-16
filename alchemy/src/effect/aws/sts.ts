import * as Context from "effect/Context";
import { STS as STSClient } from "itty-aws/sts";
import { createAWSServiceClientLayer } from "./client.ts";

export class Client extends Context.Tag("AWS::STS::Client")<
  Client,
  STSClient
>() {}

export const client = createAWSServiceClientLayer(Client, STSClient);
