import * as vpn from "@distilled.cloud/stackit/vpn";
import * as Layer from "effect/Layer";
import { makeConnectionHttpBinding } from "./BindingHttp.ts";
import { GetConnectionStatus } from "./GetConnectionStatus.ts";

/**
 * HTTP implementation of {@link GetConnectionStatus}.
 *
 * @layer
 * @provides Stackit.VPN.GetConnectionStatus
 */
export const GetConnectionStatusHttp = Layer.effect(
  GetConnectionStatus,
  makeConnectionHttpBinding({
    tag: "Stackit.VPN.GetConnectionStatus",
    permissions: ["vpn.connection.status.get"],
    operation: vpn.getGatewayConnectionStatus,
  }),
);
