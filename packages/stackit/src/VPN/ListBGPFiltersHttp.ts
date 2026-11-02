import * as vpn from "@distilled.cloud/stackit/vpn";
import * as Layer from "effect/Layer";
import { makeGatewayHttpBinding } from "./BindingHttp.ts";
import { ListBGPFilters } from "./ListBGPFilters.ts";

/**
 * HTTP implementation of {@link ListBGPFilters}.
 *
 * @layer
 * @provides Stackit.VPN.ListBGPFilters
 */
export const ListBGPFiltersHttp = Layer.effect(
  ListBGPFilters,
  makeGatewayHttpBinding({
    tag: "Stackit.VPN.ListBGPFilters",
    permissions: ["vpn.bgpfilter.list"],
    operation: vpn.listGatewayBGPFilters,
  }),
);
