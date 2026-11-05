import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { RegisterApiGatewayBinding } from "./BindingHttp.ts";

export interface UpdateApiKeyRequest extends ag.UpdateApiKeyRequest {}

/**
 * Runtime binding for patching an API Gateway API key
 * (`apigateway:PATCH` on `/apikeys/{id}`). Account-scoped — takes no
 * resource.
 *
 * Provide `ApiGateway.UpdateApiKeyHttp` on the Function effect to
 * implement the binding.
 *
 * ### Managing API keys
 * **Example:** Disable a key
 * ```typescript
 * // init
 * const updateApiKey = yield* ApiGateway.UpdateApiKey();
 *
 * // runtime
 * yield* updateApiKey({
 *   apiKey: keyId,
 *   patchOperations: [{ op: "replace", path: "/enabled", value: "false" }],
 * });
 * ```
 *
 * @binding
 */
export interface UpdateApiKey extends Binding.Service<
  UpdateApiKey,
  "AWS.ApiGateway.UpdateApiKey",
  () => Effect.Effect<
    (request: UpdateApiKeyRequest) => Effect.Effect<ag.ApiKey, ag.UpdateApiKeyError>
  >
> {}
export const UpdateApiKey = Binding.Service<UpdateApiKey>("AWS.ApiGateway.UpdateApiKey");

/**
 * HTTP implementation of the {@link UpdateApiKey} binding. Grants
 * `apigateway:PATCH` on `/apikeys/*` and calls the API with the host
 * Function's credentials.
 */
export const UpdateApiKeyHttp = Layer.effect(
  UpdateApiKey,
  Effect.gen(function* () {
    const registerApiGatewayBinding = yield* RegisterApiGatewayBinding;
    const updateApiKey = yield* AWSBindings.withCredentials(ag.updateApiKey);
    return Effect.fn(function* () {
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.UpdateApiKey",
        target: "",
        verb: "PATCH",
        paths: (region) => [`arn:aws:apigateway:${region}::/apikeys/*`],
      });
      return Effect.fn("AWS.ApiGateway.UpdateApiKey")(function* (request: UpdateApiKeyRequest) {
        return yield* updateApiKey(request);
      });
    });
  }),
);
