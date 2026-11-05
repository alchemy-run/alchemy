import * as config from "@distilled.cloud/aws/config-service";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeConfigAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `config:GetResourceConfigHistory` — read the list of
 * configuration items (change history) AWS Config recorded for a resource,
 * newest first.
 *
 * Provide `Config.GetResourceConfigHistoryHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * ### Reading Resource Configurations
 * **Example:** Read a Resource's Configuration History
 * ```typescript
 * // init — grants config:GetResourceConfigHistory
 * const getResourceConfigHistory = yield* AWS.Config.GetResourceConfigHistory();
 *
 * // runtime
 * const result = yield* getResourceConfigHistory({
 *   resourceType: "AWS::S3::Bucket",
 *   resourceId: "my-bucket",
 *   limit: 10,
 * });
 * console.log(result.configurationItems?.length);
 * ```
 *
 * @binding
 */
export interface GetResourceConfigHistory extends Binding.Service<
  GetResourceConfigHistory,
  "AWS.Config.GetResourceConfigHistory",
  () => Effect.Effect<
    (
      request: config.GetResourceConfigHistoryRequest,
    ) => Effect.Effect<
      config.GetResourceConfigHistoryResponse,
      config.GetResourceConfigHistoryError
    >
  >
> {}

export const GetResourceConfigHistory = Binding.Service<GetResourceConfigHistory>(
  "AWS.Config.GetResourceConfigHistory",
);

export const GetResourceConfigHistoryHttp = Layer.effect(
  GetResourceConfigHistory,
  makeConfigAccountHttpBinding({
    tag: "AWS.Config.GetResourceConfigHistory",
    operation: config.getResourceConfigHistory,
    actions: ["config:GetResourceConfigHistory"],
  }),
);
