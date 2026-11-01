import * as iaas from "@distilled.cloud/stackit/iaas";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  conflictRetry,
  projectScopeChanged,
  resolveProjectScope,
  type ProjectScope,
  type ProjectScopedProps,
} from "./internal.ts";

export interface ServerNetworkInterfaceAttachmentProps extends ProjectScopedProps {
  /** Server to attach the interface to. Changing it replaces the attachment. */
  serverId: string;
  /**
   * Network interface (`NetworkInterface`) to attach. Changing it replaces
   * the attachment.
   */
  networkInterfaceId: string;
  /**
   * Project of the server and interface. Defaults to the profile's
   * project. Changing it replaces the attachment.
   */
  projectId?: string;
  /**
   * Region of the server and interface. Defaults to the profile's region.
   * Changing it replaces the attachment.
   */
  region?: string;
}

export interface ServerNetworkInterfaceAttachmentAttributes {
  /** Server the interface is attached to. */
  serverId: string;
  /** Attached network interface. */
  networkInterfaceId: string;
  /** Project of the attachment. */
  projectId: string;
  /** Region of the attachment. */
  region: string;
}

export type ServerNetworkInterfaceAttachment = Resource<
  "Stackit.IaaS.ServerNetworkInterfaceAttachment",
  ServerNetworkInterfaceAttachmentProps,
  ServerNetworkInterfaceAttachmentAttributes,
  never,
  Providers
>;

/**
 * Attaches an existing STACKIT network interface to a server (hot-plug),
 * e.g. to put a server into a second network or to give it an interface
 * with a fixed address.
 *
 * Existence-only: the attachment is identified by the server and interface
 * ids and has nothing to update. It carries no labels; Alchemy tracks it by
 * the ids in state, and a deploy without state takes over an existing
 * attachment of the same pair. The server's initial interface (from
 * `Server.networking`) is not managed by this resource.
 *
 * ### Adding a second network
 * **Example:** Attach an interface in a backend network
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const frontend = yield* Stackit.IaaS.Network("Frontend", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const backend = yield* Stackit.IaaS.Network("Backend", {
 *   ipv4: { prefix: "10.0.2.0/24" },
 * });
 * const server = yield* Stackit.IaaS.Server("App", {
 *   machineType: "g1.1",
 *   bootVolume: { size: 20, source: { type: "image", id: "<image id>" } },
 *   networking: { networkId: frontend.networkId },
 * });
 * const nic = yield* Stackit.IaaS.NetworkInterface("AppBackend", {
 *   networkId: backend.networkId,
 *   ipv4: "10.0.2.10",
 * });
 * yield* Stackit.IaaS.ServerNetworkInterfaceAttachment("AppBackend", {
 *   serverId: server.serverId,
 *   networkInterfaceId: nic.networkInterfaceId,
 * });
 * ```
 *
 * ### Replacement
 * Changing `serverId`, `networkInterfaceId`, `projectId` or `region`
 * detaches the interface and attaches the new pair.
 *
 * @resource
 * @product STACKIT Compute Engine
 * @category IaaS
 */
export const ServerNetworkInterfaceAttachment = Resource<ServerNetworkInterfaceAttachment>(
  "Stackit.IaaS.ServerNetworkInterfaceAttachment",
);

/** Whether the interface is attached to the server (`undefined` when the server is gone). */
const isAttached = (scope: ProjectScope, serverId: string, networkInterfaceId: string) =>
  iaas.listServerNICs({ ...scope, serverId }).pipe(
    Effect.map(({ items }) => items.some((nic) => nic.id === networkInterfaceId)),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

const toAttrs = (
  scope: ProjectScope,
  ids: { serverId: string; networkInterfaceId: string },
): ServerNetworkInterfaceAttachmentAttributes => ({ ...ids, ...scope });

export const ServerNetworkInterfaceAttachmentProvider = () =>
  Provider.succeed(ServerNetworkInterfaceAttachment, {
    stables: ["serverId", "networkInterfaceId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.IaaS.Server", "Stackit.IaaS.NetworkInterface"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      if (yield* projectScopeChanged(news, output)) return { action: "replace" } as const;
      if (
        news.serverId !== output.serverId ||
        news.networkInterfaceId !== output.networkInterfaceId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      // No ownership marker: without a recorded pair, reconcile takes over
      // an existing attachment instead.
      if (output === undefined) return undefined;
      const scope = { projectId: output.projectId, region: output.region };
      const attached = yield* isAttached(scope, output.serverId, output.networkInterfaceId);
      return attached ? toAttrs(scope, output) : undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const ids = { serverId: news.serverId, networkInterfaceId: news.networkInterfaceId };

      // Observe, then ensure. `Conflict` while the server is busy.
      if (!(yield* isAttached(scope, ids.serverId, ids.networkInterfaceId))) {
        yield* iaas
          .addNicToServer({ ...scope, serverId: ids.serverId, nicId: ids.networkInterfaceId })
          .pipe(Effect.retry(conflictRetry));
        yield* waitFor({
          resource: `STACKIT network interface ${ids.networkInterfaceId} on server ${ids.serverId}`,
          read: isAttached(scope, ids.serverId, ids.networkInterfaceId),
          ready: (attached) => attached,
          timeout: "2 minutes",
        });
      }
      return toAttrs(scope, ids);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      yield* iaas
        .removeNicFromServer({
          ...scope,
          serverId: output.serverId,
          nicId: output.networkInterfaceId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone({
        resource: `STACKIT network interface ${output.networkInterfaceId} on server ${output.serverId}`,
        read: isAttached(scope, output.serverId, output.networkInterfaceId).pipe(
          Effect.map((attached) => (attached ? "attached" : undefined)),
        ),
        timeout: "2 minutes",
      });
    }),
  });
