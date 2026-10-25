import * as mysql from "@distilled.cloud/azure/mysql";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { FlexibleServer } from "./FlexibleServer.ts";
import { StopServer } from "./StopServer.ts";

/**
 * Implementation of {@link StopServer} over the distilled `mysql` ARM
 * operation `StopServer`. Assigns the custom `AzureMySQLStopServerRole` on
 * the server.
 *
 * @layer
 * @provides Azure.MySQL.StopServer
 */
export const StopServerHttp = Layer.effect(
  StopServer,
  makeArmActionBinding({
    tag: "Azure.MySQL.StopServer",
    operation: mysql.StopServer,
    role: {
      role: "MySQLStopServer",
      actions: ["Microsoft.DBforMySQL/flexibleServers/stop/action"],
    },
    resourceId: (server: FlexibleServer) => server.serverId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      serverName: id.name("flexibleServers"),
    }),
  }),
);
