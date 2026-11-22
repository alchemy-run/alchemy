import * as mysql from "@distilled.cloud/azure/mysql";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import { FailoverServer } from "./FailoverServer.ts";
import type { FlexibleServer } from "./FlexibleServer.ts";

/**
 * Implementation of {@link FailoverServer} over the distilled `mysql` ARM
 * operation `ServersFailover`. Assigns the custom `AzureMySQLFailoverServerRole` on
 * the server.
 *
 * @layer
 * @provides Azure.MySQL.FailoverServer
 */
export const FailoverServerHttp = Layer.effect(
  FailoverServer,
  makeArmActionBinding({
    tag: "Azure.MySQL.FailoverServer",
    operation: mysql.ServersFailover,
    role: {
      role: "MySQLFailoverServer",
      actions: ["Microsoft.DBforMySQL/flexibleServers/failover/action"],
    },
    resourceId: (server: FlexibleServer) => server.serverId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      serverName: id.name("flexibleServers"),
    }),
  }),
);
