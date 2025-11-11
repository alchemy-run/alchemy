import * as Context from "effect/Context";

import { Lambda } from "itty-aws/lambda";
import { createAWSServiceClientLayer } from "../client.ts";

export class LambdaClient extends Context.Tag("AWS.Lambda.Client")<
  LambdaClient,
  Lambda
>() {}

export const client = createAWSServiceClientLayer<typeof LambdaClient, Lambda>(
  LambdaClient,
  Lambda,
);
