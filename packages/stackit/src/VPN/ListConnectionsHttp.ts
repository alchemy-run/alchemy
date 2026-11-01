import * as vpn from "@distilled.cloud/stackit/vpn";
import * as Layer from "effect/Layer";
import { makeGatewayHttpBinding } from "./BindingHttp.ts";
import { ListConnections } from "./ListConnections.ts";

/**
 * HTTP implementation of {@link ListConnections}.
 *
 * @layer
 * @provides Stackit.VPN.ListConnections
 */
export const ListConnectionsHttp = Layer.effect(
  ListConnections,
  makeGatewayHttpBinding({
    tag: "Stackit.VPN.ListConnections",
    permissions: ["vpn.connection.list"],
    operation: vpn.listGatewayConnections,
  }),
);
