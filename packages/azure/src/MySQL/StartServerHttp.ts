import * as mysql from "@distilled.cloud/azure/mysql";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { FlexibleServer } from "./FlexibleServer.ts";
import { StartServer } from "./StartServer.ts";

/**
 * Implementation of {@link StartServer} over the distilled `mysql` ARM
 * operation `StartServer`. Assigns the custom `AzureMySQLStartServerRole` on
 * the server.
 *
 * @layer
 * @provides Azure.MySQL.StartServer
 */
export const StartServerHttp = Layer.effect(
  StartServer,
  makeArmActionBinding({
    tag: "Azure.MySQL.StartServer",
    operation: mysql.StartServer,
    role: {
      role: "MySQLStartServer",
      actions: ["Microsoft.DBforMySQL/flexibleServers/start/action"],
    },
    resourceId: (server: FlexibleServer) => server.serverId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      serverName: id.name("flexibleServers"),
    }),
  }),
);
