import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as recommendationengine from "@distilled.cloud/gcp/recommendationengine_v1beta1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import type { CatalogsCatalogItem } from "./CatalogsCatalogItem.ts";

export interface GetCatalogItemRequest extends Omit<
  recommendationengine.GetProjectsLocationsCatalogsCatalogItemsRequest,
  "name"
> {}

/**
 * Runtime binding for Recommendations AI `catalogItems.get`.
 *
 * Bind this operation to a {@link CatalogsCatalogItem} in a Function
 * or Action init phase. Provide {@link GetCatalogItemHttp}.
 *
 * Grants `roles/automlrecommendations.viewer` on the project:
 * Recommendations AI has no resource-level IAM.
 *
 * ### Reading Catalog Items
 * **Example:** Read the bound catalog item
 * ```typescript
 * const getCatalogItem = yield* GCP.RecommendationEngine.GetCatalogItem(item);
 * const live = yield* getCatalogItem();
 * ```
 *
 * @binding
 * @category RecommendationEngine
 */
export interface GetCatalogItem extends Binding.Service<
  GetCatalogItem,
  "GCP.RecommendationEngine.GetCatalogItem",
  (
    item: CatalogsCatalogItem,
  ) => Effect.Effect<
    (
      request?: GetCatalogItemRequest,
    ) => Effect.Effect<
      recommendationengine.GoogleCloudRecommendationengineV1beta1CatalogItem,
      recommendationengine.GetProjectsLocationsCatalogsCatalogItemsError,
      RuntimeContext
    >
  >
> {}

export const GetCatalogItem = Binding.Service<GetCatalogItem>(
  "GCP.RecommendationEngine.GetCatalogItem",
);

/**
 * HTTP implementation of {@link GetCatalogItem}.
 *
 * @layer
 * @provides GCP.RecommendationEngine.GetCatalogItem
 */
export const GetCatalogItemHttp: Layer.Layer<
  GetCatalogItem,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  GetCatalogItem,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(
      recommendationengine.getProjectsLocationsCatalogsCatalogItems,
    );
    return Effect.fn(function* (item: CatalogsCatalogItem) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.RecommendationEngine.GetCatalogItem(${item})`({
          iam: [{ role: "roles/automlrecommendations.viewer" }],
        });
      }
      const name = yield* item.name;
      return Effect.fn(`GCP.RecommendationEngine.GetCatalogItem(${item.LogicalId})`)(function* (
        _request?: GetCatalogItemRequest,
      ) {
        return yield* run({ name: yield* name });
      });
    });
  }),
);
