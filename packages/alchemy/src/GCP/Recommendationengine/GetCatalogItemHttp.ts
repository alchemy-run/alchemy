import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as recommendationengine from "@distilled.cloud/gcp/recommendationengine_v1beta1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { CatalogsCatalogItem } from "./CatalogsCatalogItem.ts";
import {
  GetCatalogItem,
  type GetCatalogItemRequest,
} from "./GetCatalogItem.ts";

/**
 * HTTP implementation of {@link GetCatalogItem}.
 *
 * @layer
 * @provides GCP.Recommendationengine.GetCatalogItem
 */
export const GetCatalogItemHttp: Layer.Layer<
  GetCatalogItem,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  GetCatalogItem,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    const run =
      yield* recommendationengine.getProjectsLocationsCatalogsCatalogItems.pipe(
        Effect.provideService(Credentials, credentials),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
    return Effect.fn(function* (item: CatalogsCatalogItem) {
      const name = yield* item.name;
      return Effect.fn(
        `GCP.Recommendationengine.GetCatalogItem(${item.LogicalId})`,
      )(function* (_request?: GetCatalogItemRequest) {
        return yield* run({ name: yield* name });
      });
    });
  }),
);
