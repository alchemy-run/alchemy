import * as search from "@distilled.cloud/azure/maps-search";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GetPolygon } from "./GetPolygon.ts";

/**
 * Implementation of {@link GetPolygon} over the distilled `maps-search` data
 * plane. Assigns the custom `AzureMapsSearchReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GetPolygon
 */
export const GetPolygonHttp = Layer.effect(
  GetPolygon,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GetPolygon",
    operation: search.SearchGetPolygon,
    grants: [MapsRole.SearchRead],
  }),
);
