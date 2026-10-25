import * as postgresql from "@distilled.cloud/azure/postgresql";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { FlexibleServer } from "./FlexibleServer.ts";
import { StartServer } from "./StartServer.ts";

/**
 * Implementation of {@link StartServer} over the distilled `postgresql` ARM
 * operation `StartServer`. Assigns the custom `AzurePostgreSQLStartServerRole` on
 * the server.
 *
 * @layer
 * @provides Azure.PostgreSQL.StartServer
 */
export const StartServerHttp = Layer.effect(
  StartServer,
  makeArmActionBinding({
    tag: "Azure.PostgreSQL.StartServer",
    operation: postgresql.StartServer,
    role: {
      role: "PostgreSQLStartServer",
      actions: ["Microsoft.DBforPostgreSQL/flexibleServers/start/action"],
    },
    resourceId: (server: FlexibleServer) => server.serverId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      serverName: id.name("flexibleServers"),
    }),
  }),
);
