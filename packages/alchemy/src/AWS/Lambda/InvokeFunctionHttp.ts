import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import type { Function } from "./Function.ts";
import { isFunction } from "./Function.ts";
import {
  InvokeFunction,
  type InvokeFunctionRequest,
} from "./InvokeFunction.ts";

export const InvokeFunctionHttp = Layer.effect(
  InvokeFunction,
  Effect.gen(function* () {
    const invoke = yield* Lambda.invoke;

    return Effect.fn(function* (func: Function) {
      const FunctionArn = yield* func.functionArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Lambda.InvokeFunction(${func}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["lambda:InvokeFunction"],
                Resource: [Output.interpolate`${func.functionArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.Lambda.InvokeFunction(${func.LogicalId})`)(
        function* (request: InvokeFunctionRequest) {
          return yield* invoke({
            ...request,
            FunctionName: yield* FunctionArn,
          });
        },
      );
    });
  }),
);
