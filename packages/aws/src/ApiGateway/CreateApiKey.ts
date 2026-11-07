import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { RegisterApiGatewayBinding } from "./BindingHttp.ts";

export interface CreateApiKeyRequest extends ag.CreateApiKeyRequest {}

/**
 * Runtime binding for issuing API Gateway API keys
 * (`apigateway:POST` on `/apikeys`). Account-scoped — takes no resource.
 *
 * The response's `value` is `Redacted<string>` (distilled marks it
 * sensitive), so the plaintext key never leaks into logs. Provide
 * `ApiGateway.CreateApiKeyHttp` on the Function effect to implement the
 * binding.
 *
 * ### Issuing API keys
 * **Example:** Issue a key for a new customer
 * ```typescript
 * import * as Redacted from "effect/Redacted";
 *
 * // init — account-level binding takes no resource
 * const createApiKey = yield* ApiGateway.CreateApiKey();
 *
 * // runtime
 * const key = yield* createApiKey({
 *   name: `customer-${customerId}`,
 *   enabled: true,
 * });
 * const plaintext = Redacted.isRedacted(key.value)
 *   ? Redacted.value(key.value)
 *   : key.value;
 * ```
 *
 * @binding
 */
export interface CreateApiKey extends Binding.Service<
  CreateApiKey,
  "AWS.ApiGateway.CreateApiKey",
  () => Effect.Effect<
    (request?: CreateApiKeyRequest) => Effect.Effect<ag.ApiKey, ag.CreateApiKeyError>
  >
> {}
export const CreateApiKey = Binding.Service<CreateApiKey>("AWS.ApiGateway.CreateApiKey");

/**
 * HTTP implementation of the {@link CreateApiKey} binding. Grants
 * `apigateway:POST` on `/apikeys` and calls the API with the host
 * Function's credentials.
 */
export const CreateApiKeyHttp = Layer.effect(
  CreateApiKey,
  Effect.gen(function* () {
    const registerApiGatewayBinding = yield* RegisterApiGatewayBinding;
    const createApiKey = yield* AWSBindings.withCredentials(ag.createApiKey);
    return Effect.fn(function* () {
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.CreateApiKey",
        target: "",
        verb: "POST",
        paths: (region) => [`arn:aws:apigateway:${region}::/apikeys`],
      });
      return Effect.fn("AWS.ApiGateway.CreateApiKey")(function* (request?: CreateApiKeyRequest) {
        return yield* createApiKey(request ?? {});
      });
    });
  }),
);
