import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { RegisterApiGatewayBinding } from "./BindingHttp.ts";

export interface DeleteApiKeyRequest extends ag.DeleteApiKeyRequest {}

/**
 * Runtime binding for deleting an API Gateway API key
 * (`apigateway:DELETE` on `/apikeys/{id}`). Account-scoped — takes no
 * resource.
 *
 * Provide `ApiGateway.DeleteApiKeyHttp` on the Function effect to
 * implement the binding.
 *
 * ### Managing API keys
 * **Example:** Delete a key on account closure
 * ```typescript
 * // init
 * const deleteApiKey = yield* ApiGateway.DeleteApiKey();
 *
 * // runtime
 * yield* deleteApiKey({ apiKey: keyId }).pipe(
 *   Effect.catchTag("NotFoundException", () => Effect.void),
 * );
 * ```
 *
 * @binding
 */
export interface DeleteApiKey extends Binding.Service<
  DeleteApiKey,
  "AWS.ApiGateway.DeleteApiKey",
  () => Effect.Effect<
    (request: DeleteApiKeyRequest) => Effect.Effect<ag.DeleteApiKeyResponse, ag.DeleteApiKeyError>
  >
> {}
export const DeleteApiKey = Binding.Service<DeleteApiKey>("AWS.ApiGateway.DeleteApiKey");

/**
 * HTTP implementation of the {@link DeleteApiKey} binding. Grants
 * `apigateway:DELETE` on `/apikeys/*` and calls the API with the host
 * Function's credentials.
 */
export const DeleteApiKeyHttp = Layer.effect(
  DeleteApiKey,
  Effect.gen(function* () {
    const registerApiGatewayBinding = yield* RegisterApiGatewayBinding;
    const deleteApiKey = yield* AWSBindings.withCredentials(ag.deleteApiKey);
    return Effect.fn(function* () {
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.DeleteApiKey",
        target: "",
        verb: "DELETE",
        paths: (region) => [`arn:aws:apigateway:${region}::/apikeys/*`],
      });
      return Effect.fn("AWS.ApiGateway.DeleteApiKey")(function* (request: DeleteApiKeyRequest) {
        return yield* deleteApiKey(request);
      });
    });
  }),
);
