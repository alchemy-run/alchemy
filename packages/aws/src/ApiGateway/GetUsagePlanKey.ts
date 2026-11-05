import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { RegisterApiGatewayBinding } from "./BindingHttp.ts";
import type { UsagePlan } from "./UsagePlan.ts";

export interface GetUsagePlanKeyRequest extends Omit<ag.GetUsagePlanKeyRequest, "usagePlanId"> {}

/**
 * Runtime binding for reading a single API key enrolled in a
 * {@link UsagePlan} (`apigateway:GET` on `/usageplans/{id}/keys/{keyId}`).
 *
 * Provide `ApiGateway.GetUsagePlanKeyHttp` on the Function effect to
 * implement the binding.
 *
 * ### Managing plan keys
 * **Example:** Check a key's enrollment
 * ```typescript
 * // init
 * const getUsagePlanKey = yield* ApiGateway.GetUsagePlanKey(plan);
 *
 * // runtime
 * const enrolled = yield* getUsagePlanKey({ keyId }).pipe(
 *   Effect.map(() => true),
 *   Effect.catchTag("NotFoundException", () => Effect.succeed(false)),
 * );
 * ```
 *
 * @binding
 */
export interface GetUsagePlanKey extends Binding.Service<
  GetUsagePlanKey,
  "AWS.ApiGateway.GetUsagePlanKey",
  <P extends UsagePlan>(
    usagePlan: P,
  ) => Effect.Effect<
    (request: GetUsagePlanKeyRequest) => Effect.Effect<ag.UsagePlanKey, ag.GetUsagePlanKeyError>
  >
> {}
export const GetUsagePlanKey = Binding.Service<GetUsagePlanKey>("AWS.ApiGateway.GetUsagePlanKey");

/**
 * HTTP implementation of the {@link GetUsagePlanKey} binding. Grants
 * `apigateway:GET` on the plan's per-key paths and calls the API with the
 * host Function's credentials.
 */
export const GetUsagePlanKeyHttp = Layer.effect(
  GetUsagePlanKey,
  Effect.gen(function* () {
    const registerApiGatewayBinding = yield* RegisterApiGatewayBinding;
    const getUsagePlanKey = yield* AWSBindings.withCredentials(ag.getUsagePlanKey);
    return Effect.fn(function* <P extends UsagePlan>(usagePlan: P) {
      const UsagePlanId = yield* usagePlan.id;
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.GetUsagePlanKey",
        target: usagePlan,
        verb: "GET",
        paths: (region) => [
          Output.interpolate`arn:aws:apigateway:${region}::/usageplans/${usagePlan.id}/keys/*`,
        ],
      });
      return Effect.fn(`AWS.ApiGateway.GetUsagePlanKey(${usagePlan.LogicalId})`)(function* (
        request: GetUsagePlanKeyRequest,
      ) {
        return yield* getUsagePlanKey({
          ...request,
          usagePlanId: yield* UsagePlanId,
        });
      });
    });
  }),
);
