import * as postgresql from "@distilled.cloud/azure/postgresql";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { FlexibleServer } from "./FlexibleServer.ts";
import { StopServer } from "./StopServer.ts";

/**
 * Implementation of {@link StopServer} over the distilled `postgresql` ARM
 * operation `StopServer`. Assigns the custom `AzurePostgreSQLStopServerRole` on
 * the server.
 *
 * @layer
 * @provides Azure.PostgreSQL.StopServer
 */
export const StopServerHttp = Layer.effect(
  StopServer,
  makeArmActionBinding({
    tag: "Azure.PostgreSQL.StopServer",
    operation: postgresql.StopServer,
    role: {
      role: "PostgreSQLStopServer",
      actions: ["Microsoft.DBforPostgreSQL/flexibleServers/stop/action"],
    },
    resourceId: (server: FlexibleServer) => server.serverId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      serverName: id.name("flexibleServers"),
    }),
  }),
);
