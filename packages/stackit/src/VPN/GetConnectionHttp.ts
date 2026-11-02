import * as vpn from "@distilled.cloud/stackit/vpn";
import * as Layer from "effect/Layer";
import { makeConnectionHttpBinding } from "./BindingHttp.ts";
import { GetConnection } from "./GetConnection.ts";

/**
 * HTTP implementation of {@link GetConnection}.
 *
 * @layer
 * @provides Stackit.VPN.GetConnection
 */
export const GetConnectionHttp = Layer.effect(
  GetConnection,
  makeConnectionHttpBinding({
    tag: "Stackit.VPN.GetConnection",
    permissions: ["vpn.connection.get"],
    operation: vpn.getGatewayConnection,
  }),
);
