import * as vpn from "@distilled.cloud/stackit/vpn";
import * as Layer from "effect/Layer";
import { makeScopeHttpBinding } from "./BindingHttp.ts";
import { ListGateways } from "./ListGateways.ts";

/**
 * HTTP implementation of {@link ListGateways}.
 *
 * @layer
 * @provides Stackit.VPN.ListGateways
 */
export const ListGatewaysHttp = Layer.effect(
  ListGateways,
  makeScopeHttpBinding({
    tag: "Stackit.VPN.ListGateways",
    permissions: ["vpn.gateway.list"],
    operation: vpn.listGateways,
  }),
);
