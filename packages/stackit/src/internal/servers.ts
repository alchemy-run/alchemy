import * as iaas from "@distilled.cloud/stackit/iaas";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import type { ProjectScope } from "../IaaS/internal.ts";
import { isAlchemyOwned } from "../Labels.ts";

/**
 * Shared scaffolding of the per-server STACKIT management services, Server Backup and
 * Server Update. Their objects have no labels, so state and generated names are all
 * that prove ownership.
 */

/** The server a per-server service acts on. */
export interface ServerTarget extends ProjectScope {
  serverId: string;
}

/**
 * Longest generated name of a schedule or backup. The Backup spec allows 255 characters
 * and the Update spec states no limit, so both stay well inside what any name field takes.
 */
export const SERVER_OBJECT_NAME_MAX_LENGTH = 63;

/**
 * The name this generation of a schedule or backup gets when none is set. It ends in the
 * instance id, which makes it the only name that proves a found object is ours.
 */
export const generatedServerObjectName = (id: string, instanceId: string) =>
  createPhysicalName({
    id,
    instanceId,
    lowercase: true,
    maxLength: SERVER_OBJECT_NAME_MAX_LENGTH,
  });

/** The target an attribute row recorded. */
export const recordedTarget = (output: ServerTarget): ServerTarget => ({
  projectId: output.projectId,
  region: output.region,
  serverId: output.serverId,
});

/** Whether a deployed row sits on this server, in this project and region. */
export const isOnTarget = (output: ServerTarget | undefined, target: ServerTarget): boolean =>
  output !== undefined &&
  output.serverId === target.serverId &&
  output.projectId === target.projectId &&
  output.region === target.region;

/**
 * The Alchemy-owned servers of the profile's project and region, for `list` (nuke). These
 * services have no project-wide list, and a server this stack didn't create isn't ours to
 * enumerate.
 */
export const listOwnedServers = Effect.gen(function* () {
  const env = yield* StackitEnvironment.current;
  const scope = { projectId: env.projectId, region: env.region };
  const { items } = yield* iaas.listServers({ ...scope, details: true });
  return items.flatMap((server): ServerTarget[] =>
    server.id !== undefined && isAlchemyOwned(server.labels)
      ? [{ ...scope, serverId: server.id }]
      : [],
  );
});
