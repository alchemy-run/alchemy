import * as search from "@distilled.cloud/azure/maps-search";
import * as Layer from "effect/Layer";
import { MapsRole, makeMapsOperationBinding } from "./BindingHttp.ts";
import { GeocodeAutocomplete } from "./GeocodeAutocomplete.ts";

/**
 * Implementation of {@link GeocodeAutocomplete} over the distilled `maps-search` data
 * plane. Assigns the custom `AzureMapsSearchReadRole` on the
 * account.
 *
 * @layer
 * @provides Azure.Maps.GeocodeAutocomplete
 */
export const GeocodeAutocompleteHttp = Layer.effect(
  GeocodeAutocomplete,
  makeMapsOperationBinding({
    tag: "Azure.Maps.GeocodeAutocomplete",
    operation: search.SearchGetGeocodeAutocomplete,
    grants: [MapsRole.SearchRead],
  }),
);
