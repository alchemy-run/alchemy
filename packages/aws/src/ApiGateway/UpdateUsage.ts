import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { RegisterApiGatewayBinding } from "./BindingHttp.ts";
import type { UsagePlan } from "./UsagePlan.ts";

export interface UpdateUsageRequest extends Omit<ag.UpdateUsageRequest, "usagePlanId"> {}

/**
 * Runtime binding for granting a temporary quota extension to an API key
 * on a {@link UsagePlan} (`apigateway:PATCH` on
 * `/usageplans/{id}/keys/{keyId}/usage`).
 *
 * Provide `ApiGateway.UpdateUsageHttp` on the Function effect to implement
 * the binding.
 *
 * ### Metering usage
 * **Example:** Extend a key's remaining quota
 * ```typescript
 * // init
 * const updateUsage = yield* ApiGateway.UpdateUsage(plan);
 *
 * // runtime
 * yield* updateUsage({
 *   keyId,
 *   patchOperations: [
 *     { op: "replace", path: "/remaining", value: "500" },
 *   ],
 * });
 * ```
 *
 * @binding
 */
export interface UpdateUsage extends Binding.Service<
  UpdateUsage,
  "AWS.ApiGateway.UpdateUsage",
  <P extends UsagePlan>(
    usagePlan: P,
  ) => Effect.Effect<(request: UpdateUsageRequest) => Effect.Effect<ag.Usage, ag.UpdateUsageError>>
> {}
export const UpdateUsage = Binding.Service<UpdateUsage>("AWS.ApiGateway.UpdateUsage");

/**
 * HTTP implementation of the {@link UpdateUsage} binding. Grants
 * `apigateway:PATCH` on the plan's per-key `/usage` paths and calls the
 * API with the host Function's credentials.
 */
export const UpdateUsageHttp = Layer.effect(
  UpdateUsage,
  Effect.gen(function* () {
    const registerApiGatewayBinding = yield* RegisterApiGatewayBinding;
    const updateUsage = yield* AWSBindings.withCredentials(ag.updateUsage);
    return Effect.fn(function* <P extends UsagePlan>(usagePlan: P) {
      const UsagePlanId = yield* usagePlan.id;
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.UpdateUsage",
        target: usagePlan,
        verb: "PATCH",
        paths: (region) => [
          Output.interpolate`arn:aws:apigateway:${region}::/usageplans/${usagePlan.id}/keys/*/usage`,
        ],
      });
      return Effect.fn(`AWS.ApiGateway.UpdateUsage(${usagePlan.LogicalId})`)(function* (
        request: UpdateUsageRequest,
      ) {
        return yield* updateUsage({
          ...request,
          usagePlanId: yield* UsagePlanId,
        });
      });
    });
  }),
);
