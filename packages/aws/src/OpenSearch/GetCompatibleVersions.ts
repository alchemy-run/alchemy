import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOpenSearchHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for the `GetCompatibleVersions` operation (IAM action
 * `es:GetCompatibleVersions`).
 *
 * Maps engine versions to the versions they can be upgraded to — for one domain (pass `DomainName`) or for every supported version. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.GetCompatibleVersionsHttp)`.
 * ### Engine Upgrades
 * **Example:** Find Valid Upgrade Targets
 * ```typescript
 * const getCompatibleVersions = yield* OpenSearch.GetCompatibleVersions();
 *
 * const result = yield* getCompatibleVersions({ DomainName: name });
 * // result.CompatibleVersions?.[0]?.TargetVersions → upgrade targets
 * ```
 *
 * @binding
 */
export interface GetCompatibleVersions extends Binding.Service<
  GetCompatibleVersions,
  "AWS.OpenSearch.GetCompatibleVersions",
  () => Effect.Effect<
    (
      request?: opensearch.GetCompatibleVersionsRequest,
    ) => Effect.Effect<
      opensearch.GetCompatibleVersionsResponse,
      opensearch.GetCompatibleVersionsError
    >
  >
> {}
export const GetCompatibleVersions = Binding.Service<GetCompatibleVersions>(
  "AWS.OpenSearch.GetCompatibleVersions",
);

export const GetCompatibleVersionsHttp = Layer.effect(
  GetCompatibleVersions,
  makeOpenSearchHttpBinding({
    tag: "AWS.OpenSearch.GetCompatibleVersions",
    operation: opensearch.getCompatibleVersions,
    actions: ["es:GetCompatibleVersions"],
  }),
);
