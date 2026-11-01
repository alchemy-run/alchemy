import * as vpn from "@distilled.cloud/stackit/vpn";
import * as Layer from "effect/Layer";
import { makeFilterHttpBinding } from "./BindingHttp.ts";
import { ListBGPFilterRules } from "./ListBGPFilterRules.ts";

/**
 * HTTP implementation of {@link ListBGPFilterRules}.
 *
 * @layer
 * @provides Stackit.VPN.ListBGPFilterRules
 */
export const ListBGPFilterRulesHttp = Layer.effect(
  ListBGPFilterRules,
  makeFilterHttpBinding({
    tag: "Stackit.VPN.ListBGPFilterRules",
    permissions: ["vpn.bgpfilter.list"],
    operation: vpn.listGatewayBGPFilterRules,
  }),
);
