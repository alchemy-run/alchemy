import * as Effect from "effect/Effect";

import { $, Binding, type Capability, declare, toEnvKey } from "alchemy-effect";
import { FunctionClient } from "./function.client.ts";
import { Function } from "./function.ts";

export interface InvokeFunction<Resource = unknown>
  extends Capability<"AWS.Lambda.InvokeFunction", Resource> {}

export const InvokeFunction = Binding<
  <F extends Function>(func: F) => Binding<Function, InvokeFunction<$<F>>>
>(Function, "AWS.Lambda.InvokeFunction");

export const invoke = <F extends Function>(func: F, input: any) =>
  Effect.gen(function* () {
    const lambda = yield* FunctionClient;
    const functionArn = process.env[`${func.id}-functionArn`]!;
    yield* declare<InvokeFunction<F>>();
    return yield* lambda.invoke({
      FunctionName: functionArn,
      InvocationType: "RequestResponse",
      Payload: JSON.stringify(input),
    });
  });

export const invokeFunctionFromLambda = InvokeFunction.provider.succeed({
  attach: ({ source: func }) => ({
    env: {
      [toEnvKey(func.id, "FUNCTION_ARN")]: func.attr.functionArn,
    },
    policyStatements: [
      {
        Sid: "AWS.Lambda.InvokeFunction",
        Effect: "Allow",
        Action: ["lambda:InvokeFunction"],
        Resource: [func.attr.functionArn],
      },
    ],
  }),
});
