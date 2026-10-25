import type * as sql from "@distilled.cloud/azure/sql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FailoverGroup } from "./FailoverGroup.ts";
import type { Server } from "./Server.ts";

export interface FailoverFailoverGroupRequest extends Omit<
  sql.FailoverGroupsFailoverRequest,
  "subscriptionId" | "resourceGroupName" | "serverName" | "failoverGroupName"
> {}

/**
 * Planned failover of a SQL failover group to one of its partner servers
 * (`POST …/servers/{partner}/failoverGroups/{group}/failover`): the partner
 * becomes the primary with no data loss. Bind the failover group and the
 * partner server that should become the primary. Azure answers when the
 * failover is accepted; it completes in the background.
 *
 * Binding assigns a custom role (`AzureSqlFailoverFailoverGroupRole`, one
 * per stack, shared by every host of this binding) with exactly the action
 * `Microsoft.Sql/servers/failoverGroups/failover/action`, on the failover
 * group as seen from the partner server only. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`).
 * Provide {@link FailoverFailoverGroupHttp}.
 *
 * ### Calling FailoverFailoverGroup
 * **Example:** Fail over to the partner server from a Function
 * ```typescript
 * // init
 * const failover = yield* Azure.Sql.FailoverFailoverGroup(group, secondary);
 *
 * // runtime
 * yield* failover();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const failover = yield* Azure.Sql.FailoverFailoverGroup(group, secondary);
 *   // ...
 * }).pipe(Effect.provide(Azure.Sql.FailoverFailoverGroupHttp));
 * ```
 *
 * @binding
 * @category Sql
 */
export interface FailoverFailoverGroup extends Binding.Service<
  FailoverFailoverGroup,
  "Azure.Sql.FailoverFailoverGroup",
  (
    group: FailoverGroup,
    partner: Server,
  ) => Effect.Effect<
    (
      request?: FailoverFailoverGroupRequest,
    ) => Effect.Effect<
      sql.FailoverGroupsFailoverResponse,
      sql.FailoverGroupsFailoverError,
      RuntimeContext
    >
  >
> {}

export const FailoverFailoverGroup = Binding.Service<FailoverFailoverGroup>(
  "Azure.Sql.FailoverFailoverGroup",
);
