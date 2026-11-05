import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFunctionHttpBinding } from "./BindingHttp.ts";
import type { Function } from "./Function.ts";

export interface InvokeFunctionRequest extends Omit<Lambda.InvocationRequest, "FunctionName"> {}

/** @binding */
export interface InvokeFunction extends Binding.Service<
  InvokeFunction,
  "AWS.Lambda.InvokeFunction",
  (
    func: Function,
  ) => Effect.Effect<
    (request: InvokeFunctionRequest) => Effect.Effect<Lambda.InvocationResponse, Lambda.InvokeError>
  >
> {}
export const InvokeFunction = Binding.Service<InvokeFunction>("AWS.Lambda.InvokeFunction");

export const InvokeFunctionHttp = Layer.effect(
  InvokeFunction,
  makeFunctionHttpBinding({
    tag: "AWS.Lambda.InvokeFunction",
    operation: Lambda.invoke,
    actions: ["lambda:InvokeFunction"],
    qualified: true,
  }),
);
