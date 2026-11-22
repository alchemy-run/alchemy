import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { ReplaceStacCollectionTileSettings } from "./ReplaceStacCollectionTileSettings.ts";

/**
 * Implementation of {@link ReplaceStacCollectionTileSettings} over the
 * distilled `orbital-planetary-computer` data plane. Assigns **GeoCatalog
 * Administrator** on the catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.ReplaceStacCollectionTileSettings
 */
export const ReplaceStacCollectionTileSettingsHttp = Layer.effect(
  ReplaceStacCollectionTileSettings,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.ReplaceStacCollectionTileSettings",
    operation: geocatalog.ReplaceStacCollectionTileSettings,
    grant: GeoCatalogRole.Administrator,
  }),
);
