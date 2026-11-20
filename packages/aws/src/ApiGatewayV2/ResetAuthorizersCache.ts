import * as agw2 from "@distilled.cloud/aws/apigatewayv2";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { RegisterApiGatewayV2Binding } from "./BindingHttp.ts";
import type { ApiGatewayV2Stage } from "./Stage.ts";

/**
 * Runtime binding for resetting a stage's authorizer result cache
 * (`apigateway:DELETE` on `/apis/{apiId}/stages/{stageName}/cache/authorizers`).
 *
 * Bind a {@link Stage} inside a function runtime to drop cached Lambda
 * authorizer verdicts — e.g. immediately revoking access after a
 * permission change, without waiting out `authorizerResultTtl`. Provide
 * `ApiGatewayV2.ResetAuthorizersCacheHttp` on the Function effect to
 * implement the binding.
 *
 * ### Flushing caches
 * **Example:** Revoke cached authorizer verdicts
 * ```typescript
 * // init
 * const resetAuthorizersCache = yield* ApiGatewayV2.ResetAuthorizersCache(stage);
 *
 * // runtime
 * yield* resetAuthorizersCache();
 * ```
 *
 * @binding
 */
export interface ResetAuthorizersCache extends Binding.Service<
  ResetAuthorizersCache,
  "AWS.ApiGatewayV2.ResetAuthorizersCache",
  <S extends ApiGatewayV2Stage>(
    stage: S,
  ) => Effect.Effect<
    () => Effect.Effect<agw2.ResetAuthorizersCacheResponse, agw2.ResetAuthorizersCacheError>
  >
> {}
export const ResetAuthorizersCache = Binding.Service<ResetAuthorizersCache>(
  "AWS.ApiGatewayV2.ResetAuthorizersCache",
);

/**
 * HTTP implementation of the {@link ResetAuthorizersCache} binding.
 * Grants `apigateway:DELETE` on the stage's `/cache/authorizers` path and
 * calls the API with the host Function's credentials.
 */
export const ResetAuthorizersCacheHttp = Layer.effect(
  ResetAuthorizersCache,
  Effect.gen(function* () {
    const registerApiGatewayV2Binding = yield* RegisterApiGatewayV2Binding;
    const resetAuthorizersCache = yield* AWSBindings.withCredentials(agw2.resetAuthorizersCache);
    return Effect.fn(function* <S extends ApiGatewayV2Stage>(stage: S) {
      const ApiId = yield* stage.apiId;
      const StageName = yield* stage.stageName;
      yield* registerApiGatewayV2Binding({
        cap: "AWS.ApiGatewayV2.ResetAuthorizersCache",
        target: stage,
        verb: "DELETE",
        paths: (region) => [
          Output.interpolate`arn:aws:apigateway:${region}::/apis/${stage.apiId}/stages/${stage.stageName}/cache/authorizers`,
        ],
      });
      return Effect.fn(`AWS.ApiGatewayV2.ResetAuthorizersCache(${stage.LogicalId})`)(function* () {
        return yield* resetAuthorizersCache({
          ApiId: yield* ApiId,
          StageName: yield* StageName,
        });
      });
    });
  }),
);
