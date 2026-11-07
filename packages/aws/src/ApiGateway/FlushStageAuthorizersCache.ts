import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { RegisterApiGatewayBinding } from "./BindingHttp.ts";
import type { ApiGatewayStage } from "./Stage.ts";

/**
 * Runtime binding for flushing a stage's authorizer result cache
 * (`apigateway:DELETE` on `/restapis/{id}/stages/{name}/cache/authorizers`).
 *
 * Bind a {@link Stage} inside a function runtime to drop cached authorizer
 * verdicts — e.g. immediately revoking access after a permission change,
 * without waiting out `authorizerResultTtl`. Provide
 * `ApiGateway.FlushStageAuthorizersCacheHttp` on the Function effect to
 * implement the binding.
 *
 * ### Flushing caches
 * **Example:** Revoke cached authorizer verdicts
 * ```typescript
 * // init
 * const flushAuthorizers = yield* ApiGateway.FlushStageAuthorizersCache(stage);
 *
 * // runtime
 * yield* flushAuthorizers();
 * ```
 *
 * @binding
 */
export interface FlushStageAuthorizersCache extends Binding.Service<
  FlushStageAuthorizersCache,
  "AWS.ApiGateway.FlushStageAuthorizersCache",
  <S extends ApiGatewayStage>(
    stage: S,
  ) => Effect.Effect<
    () => Effect.Effect<ag.FlushStageAuthorizersCacheResponse, ag.FlushStageAuthorizersCacheError>
  >
> {}
export const FlushStageAuthorizersCache = Binding.Service<FlushStageAuthorizersCache>(
  "AWS.ApiGateway.FlushStageAuthorizersCache",
);

/**
 * HTTP implementation of the {@link FlushStageAuthorizersCache} binding.
 * Grants `apigateway:DELETE` on the stage's `/cache/authorizers` path and
 * calls the API with the host Function's credentials.
 */
export const FlushStageAuthorizersCacheHttp = Layer.effect(
  FlushStageAuthorizersCache,
  Effect.gen(function* () {
    const registerApiGatewayBinding = yield* RegisterApiGatewayBinding;
    const flushStageAuthorizersCache = yield* AWSBindings.withCredentials(
      ag.flushStageAuthorizersCache,
    );
    return Effect.fn(function* <S extends ApiGatewayStage>(stage: S) {
      const RestApiId = yield* stage.restApiId;
      const StageName = yield* stage.stageName;
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.FlushStageAuthorizersCache",
        target: stage,
        verb: "DELETE",
        paths: (region) => [
          Output.interpolate`arn:aws:apigateway:${region}::/restapis/${stage.restApiId}/stages/${stage.stageName}/cache/authorizers`,
        ],
      });
      return Effect.fn(`AWS.ApiGateway.FlushStageAuthorizersCache(${stage.LogicalId})`)(
        function* () {
          return yield* flushStageAuthorizersCache({
            restApiId: yield* RestApiId,
            stageName: yield* StageName,
          });
        },
      );
    });
  }),
);
