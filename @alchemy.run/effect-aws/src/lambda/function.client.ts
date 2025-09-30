import * as Context from "effect/Context";

import { Lambda as LambdaClient } from "itty-aws/lambda";
import { createAWSServiceClientLayer } from "../client.ts";

export class FunctionClient extends Context.Tag("AWS::Lambda::Function.Client")<
  FunctionClient,
  LambdaClient
>() {}

export const client = createAWSServiceClientLayer<
  typeof FunctionClient,
  LambdaClient
>(FunctionClient, LambdaClient);
