import * as vpn from "@distilled.cloud/stackit/vpn";
import * as Layer from "effect/Layer";
import { makeConnectionHttpBinding } from "./BindingHttp.ts";
import { UpdateConnection } from "./UpdateConnection.ts";

/**
 * HTTP implementation of {@link UpdateConnection}.
 *
 * @layer
 * @provides Stackit.VPN.UpdateConnection
 */
export const UpdateConnectionHttp = Layer.effect(
  UpdateConnection,
  makeConnectionHttpBinding({
    tag: "Stackit.VPN.UpdateConnection",
    permissions: ["vpn.connection.update"],
    operation: vpn.updateGatewayConnection,
  }),
);
