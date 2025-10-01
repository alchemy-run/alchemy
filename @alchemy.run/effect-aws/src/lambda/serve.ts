import type {
  Context as LambdaContext,
  LambdaFunctionURLEvent,
  LambdaFunctionURLResult,
} from "aws-lambda";

import { Service } from "@alchemy.run/effect";

/**
 * A Lambda Function serving a HTTP endpoint as a public URL.
 */
export const serve = Service("AWS::Lambda::Function.serve")<
  (
    event: LambdaFunctionURLEvent,
    context: LambdaContext,
  ) => LambdaFunctionURLResult
>();
