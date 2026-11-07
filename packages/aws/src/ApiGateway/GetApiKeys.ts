import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { RegisterApiGatewayBinding } from "./BindingHttp.ts";

export interface GetApiKeysRequest extends ag.GetApiKeysRequest {}

/**
 * Runtime binding for listing API Gateway API keys
 * (`apigateway:GET` on `/apikeys`). Account-scoped — takes no resource.
 *
 * Provide `ApiGateway.GetApiKeysHttp` on the Function effect to implement
 * the binding.
 *
 * ### Managing API keys
 * **Example:** Find keys by name prefix
 * ```typescript
 * // init
 * const getApiKeys = yield* ApiGateway.GetApiKeys();
 *
 * // runtime
 * const page = yield* getApiKeys({ nameQuery: "customer-", limit: 100 });
 * ```
 *
 * @binding
 */
export interface GetApiKeys extends Binding.Service<
  GetApiKeys,
  "AWS.ApiGateway.GetApiKeys",
  () => Effect.Effect<
    (request?: GetApiKeysRequest) => Effect.Effect<ag.ApiKeys, ag.GetApiKeysError>
  >
> {}
export const GetApiKeys = Binding.Service<GetApiKeys>("AWS.ApiGateway.GetApiKeys");

/**
 * HTTP implementation of the {@link GetApiKeys} binding. Grants
 * `apigateway:GET` on `/apikeys` and calls the API with the host
 * Function's credentials.
 */
export const GetApiKeysHttp = Layer.effect(
  GetApiKeys,
  Effect.gen(function* () {
    const registerApiGatewayBinding = yield* RegisterApiGatewayBinding;
    const getApiKeys = yield* AWSBindings.withCredentials(ag.getApiKeys);
    return Effect.fn(function* () {
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.GetApiKeys",
        target: "",
        verb: "GET",
        paths: (region) => [`arn:aws:apigateway:${region}::/apikeys`],
      });
      return Effect.fn("AWS.ApiGateway.GetApiKeys")(function* (request?: GetApiKeysRequest) {
        return yield* getApiKeys(request ?? {});
      });
    });
  }),
);
