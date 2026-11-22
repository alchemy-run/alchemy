import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetStacCollectionThumbnail` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetStacCollectionThumbnailRequest extends Omit<
  geocatalog.GetStacCollectionThumbnailRequest,
  "endpoint"
> {}

/**
 * Get Collection Thumbnail Get thumbnail for given collection.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetStacCollectionThumbnailHttp}.
 *
 * ### Calling GetStacCollectionThumbnail
 * **Example:** GetStacCollectionThumbnail from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getStacCollectionThumbnail = yield* Azure.PlanetaryComputer.GetStacCollectionThumbnail(catalog);
 *
 * // runtime
 * const result = yield* getStacCollectionThumbnail(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetStacCollectionThumbnailHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetStacCollectionThumbnail extends Binding.Service<
  GetStacCollectionThumbnail,
  "Azure.PlanetaryComputer.GetStacCollectionThumbnail",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetStacCollectionThumbnailRequest,
    ) => Effect.Effect<
      geocatalog.GetStacCollectionThumbnailResponse,
      geocatalog.GetStacCollectionThumbnailError,
      RuntimeContext
    >
  >
> {}

export const GetStacCollectionThumbnail = Binding.Service<GetStacCollectionThumbnail>(
  "Azure.PlanetaryComputer.GetStacCollectionThumbnail",
);
