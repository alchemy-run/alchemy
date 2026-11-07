import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { RegisterApiGatewayBinding } from "./BindingHttp.ts";
import type { UsagePlan } from "./UsagePlan.ts";

export interface CreateUsagePlanKeyRequest extends Omit<
  ag.CreateUsagePlanKeyRequest,
  "usagePlanId" | "keyType"
> {
  /**
   * Type of the key being enrolled.
   * @default "API_KEY"
   */
  keyType?: string;
}

/**
 * Runtime binding for enrolling an API key in a {@link UsagePlan}
 * (`apigateway:POST` on `/usageplans/{id}/keys`).
 *
 * The core of a self-service API-key onboarding flow: issue a key with
 * `ApiGateway.CreateApiKey`, then attach it to the plan that throttles
 * and meters it. Provide `ApiGateway.CreateUsagePlanKeyHttp` on the
 * Function effect to implement the binding.
 *
 * ### Managing plan keys
 * **Example:** Enroll a freshly issued key
 * ```typescript
 * // init
 * const createApiKey = yield* ApiGateway.CreateApiKey();
 * const createUsagePlanKey = yield* ApiGateway.CreateUsagePlanKey(plan);
 *
 * // runtime
 * const key = yield* createApiKey({ name: customerId, enabled: true });
 * yield* createUsagePlanKey({ keyId: key.id! });
 * ```
 *
 * @binding
 */
export interface CreateUsagePlanKey extends Binding.Service<
  CreateUsagePlanKey,
  "AWS.ApiGateway.CreateUsagePlanKey",
  <P extends UsagePlan>(
    usagePlan: P,
  ) => Effect.Effect<
    (
      request: CreateUsagePlanKeyRequest,
    ) => Effect.Effect<ag.UsagePlanKey, ag.CreateUsagePlanKeyError>
  >
> {}
export const CreateUsagePlanKey = Binding.Service<CreateUsagePlanKey>(
  "AWS.ApiGateway.CreateUsagePlanKey",
);

/**
 * HTTP implementation of the {@link CreateUsagePlanKey} binding. Grants
 * `apigateway:POST` on the plan's `/keys` path and calls the API with the
 * host Function's credentials.
 */
export const CreateUsagePlanKeyHttp = Layer.effect(
  CreateUsagePlanKey,
  Effect.gen(function* () {
    const registerApiGatewayBinding = yield* RegisterApiGatewayBinding;
    const createUsagePlanKey = yield* AWSBindings.withCredentials(ag.createUsagePlanKey);
    return Effect.fn(function* <P extends UsagePlan>(usagePlan: P) {
      const UsagePlanId = yield* usagePlan.id;
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.CreateUsagePlanKey",
        target: usagePlan,
        verb: "POST",
        paths: (region) => [
          Output.interpolate`arn:aws:apigateway:${region}::/usageplans/${usagePlan.id}/keys`,
        ],
      });
      return Effect.fn(`AWS.ApiGateway.CreateUsagePlanKey(${usagePlan.LogicalId})`)(function* (
        request: CreateUsagePlanKeyRequest,
      ) {
        return yield* createUsagePlanKey({
          ...request,
          keyType: request.keyType ?? "API_KEY",
          usagePlanId: yield* UsagePlanId,
        });
      });
    });
  }),
);
