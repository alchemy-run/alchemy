import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { RegisterApiGatewayBinding } from "./BindingHttp.ts";
import type { ApiGatewayStage } from "./Stage.ts";

/**
 * Runtime binding for flushing a stage's response cache
 * (`apigateway:DELETE` on `/restapis/{id}/stages/{name}/cache/data`).
 *
 * Bind a {@link Stage} inside a function runtime to invalidate cached
 * responses after a content update. Provide
 * `ApiGateway.FlushStageCacheHttp` on the Function effect to implement the
 * binding.
 *
 * ### Flushing caches
 * **Example:** Invalidate the stage cache after a write
 * ```typescript
 * // init
 * const flushStageCache = yield* ApiGateway.FlushStageCache(stage);
 *
 * // runtime
 * yield* flushStageCache();
 * ```
 *
 * @binding
 */
export interface FlushStageCache extends Binding.Service<
  FlushStageCache,
  "AWS.ApiGateway.FlushStageCache",
  <S extends ApiGatewayStage>(
    stage: S,
  ) => Effect.Effect<() => Effect.Effect<ag.FlushStageCacheResponse, ag.FlushStageCacheError>>
> {}
export const FlushStageCache = Binding.Service<FlushStageCache>("AWS.ApiGateway.FlushStageCache");

/**
 * HTTP implementation of the {@link FlushStageCache} binding. Grants
 * `apigateway:DELETE` on the stage's `/cache/data` path and calls the API
 * with the host Function's credentials.
 */
export const FlushStageCacheHttp = Layer.effect(
  FlushStageCache,
  Effect.gen(function* () {
    const registerApiGatewayBinding = yield* RegisterApiGatewayBinding;
    const flushStageCache = yield* AWSBindings.withCredentials(ag.flushStageCache);
    return Effect.fn(function* <S extends ApiGatewayStage>(stage: S) {
      const RestApiId = yield* stage.restApiId;
      const StageName = yield* stage.stageName;
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.FlushStageCache",
        target: stage,
        verb: "DELETE",
        paths: (region) => [
          Output.interpolate`arn:aws:apigateway:${region}::/restapis/${stage.restApiId}/stages/${stage.stageName}/cache/data`,
        ],
      });
      return Effect.fn(`AWS.ApiGateway.FlushStageCache(${stage.LogicalId})`)(function* () {
        return yield* flushStageCache({
          restApiId: yield* RestApiId,
          stageName: yield* StageName,
        });
      });
    });
  }),
);
