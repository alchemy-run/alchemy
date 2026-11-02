import * as vpn from "@distilled.cloud/stackit/vpn";
import * as Layer from "effect/Layer";
import { makeRuleHttpBinding } from "./BindingHttp.ts";
import { GetBGPFilterRule } from "./GetBGPFilterRule.ts";

/**
 * HTTP implementation of {@link GetBGPFilterRule}.
 *
 * @layer
 * @provides Stackit.VPN.GetBGPFilterRule
 */
export const GetBGPFilterRuleHttp = Layer.effect(
  GetBGPFilterRule,
  makeRuleHttpBinding({
    tag: "Stackit.VPN.GetBGPFilterRule",
    permissions: ["vpn.bgpfilter.get"],
    operation: vpn.getGatewayBGPFilterRule,
  }),
);
