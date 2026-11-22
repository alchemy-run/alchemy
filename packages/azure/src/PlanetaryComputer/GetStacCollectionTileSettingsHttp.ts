import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetStacCollectionTileSettings } from "./GetStacCollectionTileSettings.ts";

/**
 * Implementation of {@link GetStacCollectionTileSettings} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetStacCollectionTileSettings
 */
export const GetStacCollectionTileSettingsHttp = Layer.effect(
  GetStacCollectionTileSettings,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetStacCollectionTileSettings",
    operation: geocatalog.GetStacCollectionTileSettings,
    grant: GeoCatalogRole.Reader,
  }),
);
