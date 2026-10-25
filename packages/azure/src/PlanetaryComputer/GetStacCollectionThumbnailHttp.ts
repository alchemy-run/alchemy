import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Layer from "effect/Layer";
import { GeoCatalogRole, makeGeoCatalogHttpBinding } from "./BindingHttp.ts";
import { GetStacCollectionThumbnail } from "./GetStacCollectionThumbnail.ts";

/**
 * Implementation of {@link GetStacCollectionThumbnail} over the distilled
 * `orbital-planetary-computer` data plane. Assigns **GeoCatalog Reader** on the
 * catalog.
 *
 * @layer
 * @provides Azure.PlanetaryComputer.GetStacCollectionThumbnail
 */
export const GetStacCollectionThumbnailHttp = Layer.effect(
  GetStacCollectionThumbnail,
  makeGeoCatalogHttpBinding({
    tag: "Azure.PlanetaryComputer.GetStacCollectionThumbnail",
    operation: geocatalog.GetStacCollectionThumbnail,
    grant: GeoCatalogRole.Reader,
  }),
);
