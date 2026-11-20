import * as cloudfunctions from "@distilled.cloud/gcp/cloudfunctions_v2";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFunctionHttpBinding } from "./BindingHttp.ts";
import type { Function as CloudFunction } from "./Function.ts";

export interface GetFunctionRequest extends Omit<
  cloudfunctions.GetProjectsLocationsFunctionsRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Functions `functions.get`.
 *
 * Bind this operation to a {@link Function} in a Function/Action init phase.
 * Provide {@link GetFunctionHttp}. Grants `roles/cloudfunctions.viewer` on
 * the project under an IAM Condition naming only the bound function (2nd gen
 * functions accept only invoker roles on their own IAM policy).
 *
 * ### Reading a Function
 * **Example:** Get the bound function
 * ```typescript
 * const getFunction = yield* GCP.CloudFunctions.GetFunction(hello);
 * const live = yield* getFunction();
 * ```
 *
 * @binding
 * @category CloudFunctions
 */
export interface GetFunction extends Binding.Service<
  GetFunction,
  "GCP.CloudFunctions.GetFunction",
  (
    fn: CloudFunction,
  ) => Effect.Effect<
    (
      request?: GetFunctionRequest,
    ) => Effect.Effect<
      cloudfunctions.Cloudfunctions_Function,
      cloudfunctions.GetProjectsLocationsFunctionsError,
      RuntimeContext
    >
  >
> {}

export const GetFunction = Binding.Service<GetFunction>("GCP.CloudFunctions.GetFunction");

/**
 * HTTP implementation of {@link GetFunction}.
 *
 * @layer
 * @provides GCP.CloudFunctions.GetFunction
 */
export const GetFunctionHttp = Layer.effect(
  GetFunction,
  makeFunctionHttpBinding({
    tag: "GCP.CloudFunctions.GetFunction",
    // 2nd gen functions accept only invoker roles on their own IAM policy
    // (anything else is INVALID_ARGUMENT), so grant on the project under a
    // condition naming the function.
    iam: { role: "roles/cloudfunctions.viewer", scopeByCondition: true },
    operation: cloudfunctions.getProjectsLocationsFunctions,
  }),
);
