import * as StackitBindings from "../StackitBindings.ts";
import type { Backup } from "./Backup.ts";
import type { PublicIp } from "./PublicIp.ts";
import type { Server } from "./Server.ts";

/**
 * Shared HTTP scaffolding for IaaS bindings, one builder per resource kind.
 * NOT exported from index.ts.
 */

interface HttpBindingOptions<I, A, E> {
  /** Fully-qualified binding tag, e.g. `Stackit.IaaS.RebootServer`. */
  tag: string;
  /** What the operation needs on the project holding the resource. */
  access: StackitBindings.Access;
  /** The distilled operation; the bound resource's ids are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}

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

export const makeBackupHttpBinding = <
  I extends { projectId: string; region: string; backupId: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (backup: Backup) => ({
      projectId: backup.projectId,
      region: backup.region,
      backupId: backup.backupId,
    }),
    grants: (backup) => [StackitBindings.grantOn(backup, options.access)],
  });

export const makePublicIpHttpBinding = <
  I extends { projectId: string; region: string; publicIpId: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (publicIp: PublicIp) => ({
      projectId: publicIp.projectId,
      region: publicIp.region,
      publicIpId: publicIp.publicIpId,
    }),
    grants: (publicIp) => [StackitBindings.grantOn(publicIp, options.access)],
  });
