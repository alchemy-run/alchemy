import type { Server } from "../IaaS/Server.ts";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";
import * as StackitBindings from "../StackitBindings.ts";
import type { Schedule } from "./Schedule.ts";

/**
 * Shared HTTP scaffolding for Server Update bindings.
 * NOT exported from index.ts.
 *
 * Roles bind on the project holding the resource: STACKIT has no role binding on a single
 * server (see `StackitBindings`). The permissions come from the spec's
 * `x-stackit-authorization` on each operation.
 */

interface HttpBindingOptions<I, A, E> {
  /** Fully-qualified binding tag, e.g. `Stackit.ServerUpdate.GetService`. */
  tag: string;
  /** What the operation needs on the project holding the resource. */
  access: StackitBindings.Access;
  /** The distilled operation; the bound resource's identifiers are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}

/** A binding on one server, whichever stack manages its schedules and backups. */
export const makeServerHttpBinding = <
  I extends { projectId: string; region: string; serverId: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (server: Server) => ({
      projectId: server.projectId,
      region: server.region,
      serverId: server.serverId,
    }),
    grants: (server) => [StackitBindings.grantOn(server, options.access)],
  });

export const makeScheduleHttpBinding = <
  I extends { projectId: string; region: string; serverId: string; scheduleId: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (schedule: Schedule) => ({
      projectId: schedule.projectId,
      region: schedule.region,
      serverId: schedule.serverId,
      scheduleId: schedule.scheduleId,
    }),
    grants: (schedule) => [StackitBindings.grantOn(schedule, options.access)],
  });

/** A binding on a whole project: its path has no region or server. */
export const makeProjectHttpBinding = <I extends { projectId: string }, A, E>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (scope: BindingScope) => ({ projectId: scope.projectId }),
    grants: (scope) => [StackitBindings.grantOn(scope, options.access)],
  });
