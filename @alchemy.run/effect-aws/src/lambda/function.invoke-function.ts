import * as Effect from "effect/Effect";

import { allow, type Allow } from "@alchemy.run/effect";
import { FunctionClient } from "./function.client.ts";
import type { Function } from "./function.ts";

export type InvokeFunction<F extends Function> = Allow<
  "lambda:InvokeFunction",
  F
>;

// TODO(sam): implement
export declare const InvokeFunction: <F extends Function>(
  func: F,
) => InvokeFunction<F>;

export const invoke = <F extends Function>(func: F, input: any) =>
  Effect.gen(function* () {
    const lambda = yield* FunctionClient;
    const functionArn = process.env[`${func.id}-functionArn`]!;
    yield* allow<InvokeFunction<F>>();
    return yield* lambda.invoke({
      FunctionName: functionArn,
      InvocationType: "RequestResponse",
      Payload: JSON.stringify(input),
    });
  });
