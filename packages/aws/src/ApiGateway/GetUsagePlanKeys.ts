import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { RegisterApiGatewayBinding } from "./BindingHttp.ts";
import type { UsagePlan } from "./UsagePlan.ts";

export interface GetUsagePlanKeysRequest extends Omit<ag.GetUsagePlanKeysRequest, "usagePlanId"> {}

/**
 * Runtime binding for listing the API keys enrolled in a
 * {@link UsagePlan} (`apigateway:GET` on `/usageplans/{id}/keys`).
 *
 * Provide `ApiGateway.GetUsagePlanKeysHttp` on the Function effect to
 * implement the binding.
 *
 * ### Managing plan keys
 * **Example:** List enrolled keys
 * ```typescript
 * // init
 * const getUsagePlanKeys = yield* ApiGateway.GetUsagePlanKeys(plan);
 *
 * // runtime
 * const page = yield* getUsagePlanKeys({ limit: 100 });
 * ```
 *
 * @binding
 */
export interface GetUsagePlanKeys extends Binding.Service<
  GetUsagePlanKeys,
  "AWS.ApiGateway.GetUsagePlanKeys",
  <P extends UsagePlan>(
    usagePlan: P,
  ) => Effect.Effect<
    (request?: GetUsagePlanKeysRequest) => Effect.Effect<ag.UsagePlanKeys, ag.GetUsagePlanKeysError>
  >
> {}
export const GetUsagePlanKeys = Binding.Service<GetUsagePlanKeys>(
  "AWS.ApiGateway.GetUsagePlanKeys",
);

/**
 * HTTP implementation of the {@link GetUsagePlanKeys} binding. Grants
 * `apigateway:GET` on the plan's `/keys` path and calls the API with the
 * host Function's credentials.
 */
export const GetUsagePlanKeysHttp = Layer.effect(
  GetUsagePlanKeys,
  Effect.gen(function* () {
    const registerApiGatewayBinding = yield* RegisterApiGatewayBinding;
    const getUsagePlanKeys = yield* AWSBindings.withCredentials(ag.getUsagePlanKeys);
    return Effect.fn(function* <P extends UsagePlan>(usagePlan: P) {
      const UsagePlanId = yield* usagePlan.id;
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.GetUsagePlanKeys",
        target: usagePlan,
        verb: "GET",
        paths: (region) => [
          Output.interpolate`arn:aws:apigateway:${region}::/usageplans/${usagePlan.id}/keys`,
        ],
      });
      return Effect.fn(`AWS.ApiGateway.GetUsagePlanKeys(${usagePlan.LogicalId})`)(function* (
        request?: GetUsagePlanKeysRequest,
      ) {
        return yield* getUsagePlanKeys({
          ...request,
          usagePlanId: yield* UsagePlanId,
        });
      });
    });
  }),
);
