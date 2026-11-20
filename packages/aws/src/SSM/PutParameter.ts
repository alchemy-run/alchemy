import * as SSM from "@distilled.cloud/aws/ssm";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeParameterHttpBinding } from "./BindingHttp.ts";
import type { Parameter } from "./Parameter.ts";

export interface PutParameterRequest extends Omit<SSM.PutParameterRequest, "Name"> {}

/**
 * Runtime binding for `ssm:PutParameter`.
 *
 * Bind this operation to a `Parameter` inside a function runtime to get a
 * callable that writes a new version of the bound parameter — e.g. flipping a
 * feature flag or rotating a stored secret at runtime. For `SecureString`
 * parameters the binding also grants `kms:Encrypt` and `kms:GenerateDataKey`
 * on the parameter's encryption key.
 *
 * Pass `Overwrite: true` to update the existing parameter (the parameter
 * already exists — it is managed by the `Parameter` resource). Note that a
 * runtime write drifts the value from the deployed desired state; the next
 * deploy converges it back.
 * ### Writing a Parameter
 * **Example:** Update a Feature Flag at Runtime
 * ```typescript
 * const putFlag = yield* SSM.PutParameter(flag);
 *
 * const result = yield* putFlag({ Value: "on", Overwrite: true });
 * yield* Effect.log(`flag now at version ${result.Version}`);
 * ```
 *
 * @binding
 */
export interface PutParameter extends Binding.Service<
  PutParameter,
  "AWS.SSM.PutParameter",
  <P extends Parameter>(
    parameter: P,
  ) => Effect.Effect<
    (request: PutParameterRequest) => Effect.Effect<SSM.PutParameterResult, SSM.PutParameterError>
  >
> {}
export const PutParameter = Binding.Service<PutParameter>("AWS.SSM.PutParameter");

export const PutParameterHttp = Layer.effect(
  PutParameter,
  makeParameterHttpBinding({
    tag: "AWS.SSM.PutParameter",
    operation: SSM.putParameter,
    actions: ["ssm:PutParameter"],
    // kms:Encrypt + kms:GenerateDataKey so SecureString writes work with the
    // parameter's customer-managed key (GenerateDataKey covers Advanced-tier
    // parameters, which envelope-encrypt).
    kmsActions: ["kms:Encrypt", "kms:GenerateDataKey"],
  }),
);
