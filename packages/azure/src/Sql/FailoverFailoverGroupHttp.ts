import * as sql from "@distilled.cloud/azure/sql";
import * as Output from "alchemy/Output";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import { FailoverFailoverGroup } from "./FailoverFailoverGroup.ts";
import type { FailoverGroup } from "./FailoverGroup.ts";
import type { Server } from "./Server.ts";

/**
 * Implementation of {@link FailoverFailoverGroup} over the distilled `sql`
 * ARM operation `FailoverGroupsFailover`. Assigns the custom
 * `AzureSqlFailoverFailoverGroupRole` on the failover group as seen from the
 * partner server.
 *
 * @layer
 * @provides Azure.Sql.FailoverFailoverGroup
 */
export const FailoverFailoverGroupHttp = Layer.effect(
  FailoverFailoverGroup,
  makeArmActionBinding({
    tag: "Azure.Sql.FailoverFailoverGroup",
    operation: sql.FailoverGroupsFailover,
    role: {
      role: "SqlFailoverFailoverGroup",
      actions: ["Microsoft.Sql/servers/failoverGroups/failover/action"],
    },
    resourceId: (group: FailoverGroup, partner: Server) =>
      Output.interpolate`${partner.serverId}/failoverGroups/${group.failoverGroupName}`,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      serverName: id.name("servers"),
      failoverGroupName: id.name("failoverGroups"),
    }),
  }),
);
