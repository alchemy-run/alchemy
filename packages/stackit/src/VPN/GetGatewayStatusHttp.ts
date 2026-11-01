import * as vpn from "@distilled.cloud/stackit/vpn";
import * as Layer from "effect/Layer";
import { makeGatewayHttpBinding } from "./BindingHttp.ts";
import { GetGatewayStatus } from "./GetGatewayStatus.ts";

/**
 * HTTP implementation of {@link GetGatewayStatus}.
 *
 * @layer
 * @provides Stackit.VPN.GetGatewayStatus
 */
export const GetGatewayStatusHttp = Layer.effect(
  GetGatewayStatus,
  makeGatewayHttpBinding({
    tag: "Stackit.VPN.GetGatewayStatus",
    permissions: ["vpn.gateway.status.get"],
    operation: vpn.getGatewayStatus,
  }),
);
