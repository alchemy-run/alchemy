import * as vpn from "@distilled.cloud/stackit/vpn";
import * as Layer from "effect/Layer";
import { makeFilterHttpBinding } from "./BindingHttp.ts";
import { GetBGPFilter } from "./GetBGPFilter.ts";

/**
 * HTTP implementation of {@link GetBGPFilter}.
 *
 * @layer
 * @provides Stackit.VPN.GetBGPFilter
 */
export const GetBGPFilterHttp = Layer.effect(
  GetBGPFilter,
  makeFilterHttpBinding({
    tag: "Stackit.VPN.GetBGPFilter",
    permissions: ["vpn.bgpfilter.get"],
    operation: vpn.getGatewayBGPFilter,
  }),
);
