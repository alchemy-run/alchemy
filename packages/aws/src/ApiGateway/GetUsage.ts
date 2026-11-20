import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { RegisterApiGatewayBinding } from "./BindingHttp.ts";
import type { UsagePlan } from "./UsagePlan.ts";

export interface GetUsageRequest extends Omit<ag.GetUsageRequest, "usagePlanId"> {}

/**
 * Runtime binding for reading usage data of a {@link UsagePlan}
 * (`apigateway:GET` on `/usageplans/{id}/usage`).
 *
 * Bind a usage plan inside a function runtime to meter per-key API
 * consumption — the primitive for building billing or quota dashboards.
 * Provide `ApiGateway.GetUsageHttp` on the Function effect to implement
 * the binding.
 *
 * ### Metering usage
 * **Example:** Read this month's usage for a key
 * ```typescript
 * // init
 * const getUsage = yield* ApiGateway.GetUsage(plan);
 *
 * // runtime
 * const usage = yield* getUsage({
 *   keyId,
 *   startDate: "2026-07-01",
 *   endDate: "2026-07-14",
 * });
 * ```
 *
 * @binding
 */
export interface GetUsage extends Binding.Service<
  GetUsage,
  "AWS.ApiGateway.GetUsage",
  <P extends UsagePlan>(
    usagePlan: P,
  ) => Effect.Effect<(request: GetUsageRequest) => Effect.Effect<ag.Usage, ag.GetUsageError>>
> {}
export const GetUsage = Binding.Service<GetUsage>("AWS.ApiGateway.GetUsage");

/**
 * HTTP implementation of the {@link GetUsage} binding. Grants
 * `apigateway:GET` on the plan's `/usage` path and calls the API with the
 * host Function's credentials.
 */
export const GetUsageHttp = Layer.effect(
  GetUsage,
  Effect.gen(function* () {
    const registerApiGatewayBinding = yield* RegisterApiGatewayBinding;
    const getUsage = yield* AWSBindings.withCredentials(ag.getUsage);
    return Effect.fn(function* <P extends UsagePlan>(usagePlan: P) {
      const UsagePlanId = yield* usagePlan.id;
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.GetUsage",
        target: usagePlan,
        verb: "GET",
        paths: (region) => [
          Output.interpolate`arn:aws:apigateway:${region}::/usageplans/${usagePlan.id}/usage`,
        ],
      });
      return Effect.fn(`AWS.ApiGateway.GetUsage(${usagePlan.LogicalId})`)(function* (
        request: GetUsageRequest,
      ) {
        return yield* getUsage({
          ...request,
          usagePlanId: yield* UsagePlanId,
        });
      });
    });
  }),
);
