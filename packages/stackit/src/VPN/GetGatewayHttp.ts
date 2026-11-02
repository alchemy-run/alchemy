import * as vpn from "@distilled.cloud/stackit/vpn";
import * as Layer from "effect/Layer";
import { makeGatewayHttpBinding } from "./BindingHttp.ts";
import { GetGateway } from "./GetGateway.ts";

/**
 * HTTP implementation of {@link GetGateway}.
 *
 * @layer
 * @provides Stackit.VPN.GetGateway
 */
export const GetGatewayHttp = Layer.effect(
  GetGateway,
  makeGatewayHttpBinding({
    tag: "Stackit.VPN.GetGateway",
    permissions: ["vpn.gateway.get"],
    operation: vpn.getGateway,
  }),
);
