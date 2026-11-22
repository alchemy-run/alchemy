import * as postgresql from "@distilled.cloud/azure/postgresql";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { FlexibleServer } from "./FlexibleServer.ts";
import { RestartServer } from "./RestartServer.ts";

/**
 * Implementation of {@link RestartServer} over the distilled `postgresql` ARM
 * operation `RestartServer`. Assigns the custom `AzurePostgreSQLRestartServerRole` on
 * the server.
 *
 * @layer
 * @provides Azure.PostgreSQL.RestartServer
 */
export const RestartServerHttp = Layer.effect(
  RestartServer,
  makeArmActionBinding({
    tag: "Azure.PostgreSQL.RestartServer",
    operation: postgresql.RestartServer,
    role: {
      role: "PostgreSQLRestartServer",
      actions: ["Microsoft.DBforPostgreSQL/flexibleServers/restart/action"],
    },
    resourceId: (server: FlexibleServer) => server.serverId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      serverName: id.name("flexibleServers"),
    }),
  }),
);
