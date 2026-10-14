import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostAccess from "../HostAccess.ts";
import { registerApiGatewayBinding } from "./BindingHttp.ts";
import { CreateApiKey, type CreateApiKeyRequest } from "./CreateApiKey.ts";

/**
 * HTTP implementation of the {@link CreateApiKey} binding. Grants
 * `apigateway:POST` on `/apikeys` and calls the API with the host
 * Function's credentials.
 */
export const CreateApiKeyHttp = Layer.effect(
  CreateApiKey,
  Effect.gen(function* () {
    const createApiKey = yield* HostAccess.withCredentials(ag.createApiKey);
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
