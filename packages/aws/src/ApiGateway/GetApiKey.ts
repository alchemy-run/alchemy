import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { RegisterApiGatewayBinding } from "./BindingHttp.ts";

export interface GetApiKeyRequest extends ag.GetApiKeyRequest {}

/**
 * Runtime binding for reading a single API Gateway API key
 * (`apigateway:GET` on `/apikeys/{id}`). Account-scoped — takes no
 * resource.
 *
 * With `includeValue: true` the response's `value` is `Redacted<string>`.
 * Provide `ApiGateway.GetApiKeyHttp` on the Function effect to implement
 * the binding.
 *
 * ### Managing API keys
 * **Example:** Look up a key
 * ```typescript
 * // init
 * const getApiKey = yield* ApiGateway.GetApiKey();
 *
 * // runtime
 * const key = yield* getApiKey({ apiKey: keyId });
 * ```
 *
 * @binding
 */
export interface GetApiKey extends Binding.Service<
  GetApiKey,
  "AWS.ApiGateway.GetApiKey",
  () => Effect.Effect<(request: GetApiKeyRequest) => Effect.Effect<ag.ApiKey, ag.GetApiKeyError>>
> {}
export const GetApiKey = Binding.Service<GetApiKey>("AWS.ApiGateway.GetApiKey");

/**
 * HTTP implementation of the {@link GetApiKey} binding. Grants
 * `apigateway:GET` on `/apikeys/*` and calls the API with the host
 * Function's credentials.
 */
export const GetApiKeyHttp = Layer.effect(
  GetApiKey,
  Effect.gen(function* () {
    const registerApiGatewayBinding = yield* RegisterApiGatewayBinding;
    const getApiKey = yield* AWSBindings.withCredentials(ag.getApiKey);
    return Effect.fn(function* () {
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.GetApiKey",
        target: "",
        verb: "GET",
        paths: (region) => [`arn:aws:apigateway:${region}::/apikeys/*`],
      });
      return Effect.fn("AWS.ApiGateway.GetApiKey")(function* (request: GetApiKeyRequest) {
        return yield* getApiKey(request);
      });
    });
  }),
);
