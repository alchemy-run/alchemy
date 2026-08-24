import type * as cloudfunctions from "@distilled.cloud/gcp/cloudfunctions_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Function as CloudFunction } from "./Function.ts";

export interface GetFunctionRequest extends Omit<
  cloudfunctions.GetProjectsLocationsFunctionsRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Functions `functions.get`.
 *
 * Bind this operation to a {@link Function} in a Function/Action init phase.
 * Provide {@link GetFunctionHttp}.
 *
 * ### Reading a Function
 * **Example:** Get the bound function
 * ```typescript
 * const getFunction = yield* GCP.CloudFunctions.GetFunction(hello);
 * const live = yield* getFunction();
 * ```
 *
 * @binding
 * @product GCP
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

export const GetFunction = Binding.Service<GetFunction>(
  "GCP.CloudFunctions.GetFunction",
);
