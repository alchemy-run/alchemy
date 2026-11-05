import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFunctionHttpBinding } from "./BindingHttp.ts";
import type { Function } from "./Function.ts";

export interface GetFunctionRequest extends Omit<Lambda.GetFunctionRequest, "FunctionName"> {}

/**
 * Runtime binding for `lambda:GetFunction`.
 *
 * Reads the bound {@link Function}'s configuration, code location, and tags —
 * useful for introspection and operational tooling at runtime. Provide the
 * `GetFunctionHttp` layer on the Function to satisfy the binding.
 * ### Function Metadata
 * **Example:** Read a function's configuration
 * ```typescript
 * const getFunction = yield* AWS.Lambda.GetFunction(target);
 *
 * const response = yield* getFunction();
 * const memory = response.Configuration?.MemorySize;
 * ```
 *
 * @binding
 */
export interface GetFunction extends Binding.Service<
  GetFunction,
  "AWS.Lambda.GetFunction",
  (
    func: Function,
  ) => Effect.Effect<
    (
      request?: GetFunctionRequest,
    ) => Effect.Effect<Lambda.GetFunctionResponse, Lambda.GetFunctionError>
  >
> {}
export const GetFunction = Binding.Service<GetFunction>("AWS.Lambda.GetFunction");

export const GetFunctionHttp = Layer.effect(
  GetFunction,
  makeFunctionHttpBinding({
    tag: "AWS.Lambda.GetFunction",
    operation: Lambda.getFunction,
    actions: ["lambda:GetFunction"],
  }),
);
