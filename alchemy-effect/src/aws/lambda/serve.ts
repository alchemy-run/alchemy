import * as Effect from "effect/Effect";
import * as Lambda from "./function.ts";

import type {
  LambdaFunctionURLEvent as FunctionURLEvent,
  LambdaFunctionURLResult as FunctionURLResult,
} from "aws-lambda";
export type {
  LambdaFunctionURLEvent as FunctionURLEvent,
  LambdaFunctionURLResult as FunctionURLResult,
} from "aws-lambda";

export const serve =
  <const ID extends string, Req>(
    id: ID,
    {
      fetch,
    }: {
      fetch: (
        event: FunctionURLEvent,
        context: Lambda.Context,
      ) => Effect.Effect<FunctionURLResult, never, Req>;
    },
  ) =>
  <const Props extends Lambda.FunctionProps.Simplified<Req>>(props: Props) =>
    Lambda.Function(id, { handle: fetch })({
      ...props,
      url: true,
    });
