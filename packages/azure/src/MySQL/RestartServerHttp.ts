import * as mysql from "@distilled.cloud/azure/mysql";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { FlexibleServer } from "./FlexibleServer.ts";
import { RestartServer } from "./RestartServer.ts";

/**
 * Implementation of {@link RestartServer} over the distilled `mysql` ARM
 * operation `RestartServer`. Assigns the custom `AzureMySQLRestartServerRole` on
 * the server.
 *
 * @layer
 * @provides Azure.MySQL.RestartServer
 */
export const RestartServerHttp = Layer.effect(
  RestartServer,
  makeArmActionBinding({
    tag: "Azure.MySQL.RestartServer",
    operation: mysql.RestartServer,
    role: {
      role: "MySQLRestartServer",
      actions: ["Microsoft.DBforMySQL/flexibleServers/restart/action"],
    },
    resourceId: (server: FlexibleServer) => server.serverId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      serverName: id.name("flexibleServers"),
    }),
  }),
);
