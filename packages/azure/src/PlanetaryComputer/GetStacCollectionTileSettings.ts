import type * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GeoCatalog } from "./GeoCatalog.ts";

/**
 * `GetStacCollectionTileSettings` request without `endpoint`, which the bound
 * GeoCatalog (its `catalogUri`) supplies.
 */
export interface GetStacCollectionTileSettingsRequest extends Omit<
  geocatalog.GetStacCollectionTileSettingsRequest,
  "endpoint"
> {}

/**
 * Get Collection Tile Settings Get the tile settings for a given collection.
 *
 * Binding assigns the built-in **GeoCatalog Reader** role on the bound catalog
 * only. `Microsoft.Orbital` has no data actions; the GeoCatalog data plane
 * checks this role's `Microsoft.Orbital/geoCatalogs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetStacCollectionTileSettingsHttp}.
 *
 * ### Calling GetStacCollectionTileSettings
 * **Example:** GetStacCollectionTileSettings from a Function
 * ```typescript
 * // init
 * const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("imagery", {});
 * const getStacCollectionTileSettings = yield* Azure.PlanetaryComputer.GetStacCollectionTileSettings(catalog);
 *
 * // runtime
 * const result = yield* getStacCollectionTileSettings(request);
 *
 * // layer
 * Effect.provide(Azure.PlanetaryComputer.GetStacCollectionTileSettingsHttp)
 * ```
 *
 * @binding
 * @category PlanetaryComputer
 */
export interface GetStacCollectionTileSettings extends Binding.Service<
  GetStacCollectionTileSettings,
  "Azure.PlanetaryComputer.GetStacCollectionTileSettings",
  (
    catalog: GeoCatalog,
  ) => Effect.Effect<
    (
      request: GetStacCollectionTileSettingsRequest,
    ) => Effect.Effect<
      geocatalog.TileSettings,
      geocatalog.GetStacCollectionTileSettingsError,
      RuntimeContext
    >
  >
> {}

export const GetStacCollectionTileSettings = Binding.Service<GetStacCollectionTileSettings>(
  "Azure.PlanetaryComputer.GetStacCollectionTileSettings",
);
