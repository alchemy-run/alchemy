import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { RegisterApiGatewayBinding } from "./BindingHttp.ts";
import type { UsagePlan } from "./UsagePlan.ts";

export interface DeleteUsagePlanKeyRequest extends Omit<
  ag.DeleteUsagePlanKeyRequest,
  "usagePlanId"
> {}

/**
 * Runtime binding for removing an API key from a {@link UsagePlan}
 * (`apigateway:DELETE` on `/usageplans/{id}/keys/{keyId}`).
 *
 * Provide `ApiGateway.DeleteUsagePlanKeyHttp` on the Function effect to
 * implement the binding.
 *
 * ### Managing plan keys
 * **Example:** Unenroll a key on subscription cancellation
 * ```typescript
 * // init
 * const deleteUsagePlanKey = yield* ApiGateway.DeleteUsagePlanKey(plan);
 *
 * // runtime
 * yield* deleteUsagePlanKey({ keyId }).pipe(
 *   Effect.catchTag("NotFoundException", () => Effect.void),
 * );
 * ```
 *
 * @binding
 */
export interface DeleteUsagePlanKey extends Binding.Service<
  DeleteUsagePlanKey,
  "AWS.ApiGateway.DeleteUsagePlanKey",
  <P extends UsagePlan>(
    usagePlan: P,
  ) => Effect.Effect<
    (
      request: DeleteUsagePlanKeyRequest,
    ) => Effect.Effect<ag.DeleteUsagePlanKeyResponse, ag.DeleteUsagePlanKeyError>
  >
> {}
export const DeleteUsagePlanKey = Binding.Service<DeleteUsagePlanKey>(
  "AWS.ApiGateway.DeleteUsagePlanKey",
);

/**
 * HTTP implementation of the {@link DeleteUsagePlanKey} binding. Grants
 * `apigateway:DELETE` on the plan's per-key paths and calls the API with
 * the host Function's credentials.
 */
export const DeleteUsagePlanKeyHttp = Layer.effect(
  DeleteUsagePlanKey,
  Effect.gen(function* () {
    const registerApiGatewayBinding = yield* RegisterApiGatewayBinding;
    const deleteUsagePlanKey = yield* AWSBindings.withCredentials(ag.deleteUsagePlanKey);
    return Effect.fn(function* <P extends UsagePlan>(usagePlan: P) {
      const UsagePlanId = yield* usagePlan.id;
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.DeleteUsagePlanKey",
        target: usagePlan,
        verb: "DELETE",
        paths: (region) => [
          Output.interpolate`arn:aws:apigateway:${region}::/usageplans/${usagePlan.id}/keys/*`,
        ],
      });
      return Effect.fn(`AWS.ApiGateway.DeleteUsagePlanKey(${usagePlan.LogicalId})`)(function* (
        request: DeleteUsagePlanKeyRequest,
      ) {
        return yield* deleteUsagePlanKey({
          ...request,
          usagePlanId: yield* UsagePlanId,
        });
      });
    });
  }),
);
