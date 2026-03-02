import * as Lambda from "distilled-aws/lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import type { Function } from "./Function.ts";
import * as LambdaModule from "./index.ts";

export interface InvokeFunctionRequest extends Omit<
  Lambda.InvocationRequest,
  "FunctionName"
> {}

export class InvokeFunction extends Binding.Service<
  InvokeFunction,
  (
    func: Function,
  ) => Effect.Effect<
    (
      request: InvokeFunctionRequest,
    ) => Effect.Effect<Lambda.InvocationResponse, Lambda.InvokeError>
  >
>()("AWS.Lambda.InvokeFunction") {}

export const InvokeFunctionLive = Layer.effect(
  InvokeFunction,
  Effect.gen(function* () {
    const Policy = yield* InvokeFunctionPolicy;
    const invoke = yield* Lambda.invoke;

    return Effect.fn(function* (func: Function) {
      const FunctionArn = yield* func.functionArn;
      yield* Policy(func);
      return Effect.fn(function* (request: InvokeFunctionRequest) {
        return yield* invoke({
          ...request,
          FunctionName: yield* FunctionArn,
        });
      });
    });
  }),
);

export class InvokeFunctionPolicy extends Binding.Policy<
  InvokeFunctionPolicy,
  (func: Function) => Effect.Effect<void>
>()("AWS.Lambda.InvokeFunction") {}

export const InvokeFunctionPolicyLive = InvokeFunctionPolicy.layer.succeed(
  Effect.fn(function* (ctx, func: Function) {
    if (LambdaModule.isFunction(ctx)) {
      yield* ctx.bind({
        policyStatements: [
          {
            Sid: "InvokeFunction",
            Effect: "Allow",
            Action: ["lambda:InvokeFunction"],
            Resource: [Output.interpolate`${func.functionArn}`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `InvokeFunctionPolicy does not support runtime '${ctx.type}'`,
      );
    }
  }),
);
