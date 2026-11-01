import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  conflictRetry,
  projectScopeChanged,
  resolveProjectScope,
  type ProjectScope,
  type ProjectScopedProps,
} from "./internal.ts";

export interface ServerSecurityGroupAttachmentProps extends ProjectScopedProps {
  /** Server to apply the security group to. Changing it replaces the attachment. */
  serverId: string;
  /** Security group (`SecurityGroup`). Changing it replaces the attachment. */
  securityGroupId: string;
  /**
   * Project of the server and group. Defaults to the profile's project.
   * Changing it replaces the attachment.
   */
  projectId?: string;
  /**
   * Region of the server and group. Defaults to the profile's region.
   * Changing it replaces the attachment.
   */
  region?: string;
}

export interface ServerSecurityGroupAttachmentAttributes {
  /** Server the group applies to. */
  serverId: string;
  /** Applied security group. */
  securityGroupId: string;
  /** Project of the attachment. */
  projectId: string;
  /** Region of the attachment. */
  region: string;
}

export type ServerSecurityGroupAttachment = Resource<
  "Stackit.IaaS.ServerSecurityGroupAttachment",
  ServerSecurityGroupAttachmentProps,
  ServerSecurityGroupAttachmentAttributes,
  never,
  Providers
>;

/**
 * Applies a STACKIT security group to a server's network interfaces.
 *
 * Existence-only: identified by the server and group ids, nothing to
 * update. STACKIT applies the group to the server's interfaces, so Alchemy
 * treats the group as attached when any interface of the server carries
 * it. To manage the groups of a single interface instead, set
 * `NetworkInterface.securityGroups`; do not combine both for the same
 * interface. Attachments carry no labels; Alchemy tracks them by the ids in
 * state, and a deploy without state takes over an existing attachment of
 * the same pair.
 *
 * See [STACKIT's Server docs](https://docs.stackit.cloud/products/compute-engine/server/).
 *
 * :::caution[Changing `serverId`, `securityGroupId`, `projectId` or `region` replaces the Attachment]
 * A deploy removes the group from the old server and applies the new pair.
 * :::
 *
 * ### Opening a server to web traffic
 * **Example:** Apply an HTTPS security group to a server
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const https = yield* Stackit.IaaS.SecurityGroup("Https", {});
 * yield* Stackit.IaaS.SecurityGroupRule("HttpsIn", {
 *   securityGroupId: https.securityGroupId,
 *   direction: "ingress",
 *   protocol: "tcp",
 *   portRange: { min: 443, max: 443 },
 * });
 * const server = yield* Stackit.IaaS.Server("Web", {
 *   machineType: "g1.1",
 *   bootVolume: { size: 20, source: { type: "image", id: "<image id>" } },
 *   networking: { networkId: network.networkId },
 * });
 * yield* Stackit.IaaS.ServerSecurityGroupAttachment("WebHttps", {
 *   serverId: server.serverId,
 *   securityGroupId: https.securityGroupId,
 * });
 * ```
 *
 * @resource
 * @product STACKIT Compute Engine
 * @category IaaS
 */
export const ServerSecurityGroupAttachment = Resource<ServerSecurityGroupAttachment>(
  "Stackit.IaaS.ServerSecurityGroupAttachment",
);

/** Whether any interface of the server carries the group (`false` when the server is gone). */
const isAttached = (scope: ProjectScope, serverId: string, securityGroupId: string) =>
  iaas.listServerNICs({ ...scope, serverId }).pipe(
    Effect.map(({ items }) =>
      items.some((nic) => (nic.securityGroups ?? []).includes(securityGroupId)),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

const toAttrs = (
  scope: ProjectScope,
  ids: { serverId: string; securityGroupId: string },
): ServerSecurityGroupAttachmentAttributes => ({ ...ids, ...scope });

export const ServerSecurityGroupAttachmentProvider = () =>
  Provider.succeed(ServerSecurityGroupAttachment, {
    stables: ["serverId", "securityGroupId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.IaaS.Server", "Stackit.IaaS.SecurityGroup"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // Delete-first: an unresolved id can resolve to the same pair, which has
      // no generation marker. A create-first replacement would claim it, and
      // garbage collection would then remove the group from the server.
      if (
        hasUnresolvedTrigger<ServerSecurityGroupAttachmentProps>(news, [
          "projectId",
          "region",
          "serverId",
          "securityGroupId",
        ])
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<ServerSecurityGroupAttachmentProps>(news);
      if (yield* projectScopeChanged(resolved, output)) return { action: "replace" } as const;
      if (
        resolved.serverId !== output.serverId ||
        resolved.securityGroupId !== output.securityGroupId
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
      const attached = yield* isAttached(scope, output.serverId, output.securityGroupId);
      return attached ? toAttrs(scope, output) : undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const ids = { serverId: news.serverId, securityGroupId: news.securityGroupId };

      // Observe, then ensure. `Conflict` while the server is busy.
      if (!(yield* isAttached(scope, ids.serverId, ids.securityGroupId))) {
        yield* iaas
          .addSecurityGroupToServer({ ...scope, ...ids })
          .pipe(Effect.retry(conflictRetry));
        yield* waitFor({
          resource: `STACKIT security group ${ids.securityGroupId} on server ${ids.serverId}`,
          read: isAttached(scope, ids.serverId, ids.securityGroupId),
          ready: (attached) => attached,
          timeout: "1 minute",
        });
      }
      return toAttrs(scope, ids);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      yield* iaas
        .removeSecurityGroupFromServer({
          ...scope,
          serverId: output.serverId,
          securityGroupId: output.securityGroupId,
        })
        .pipe(
          Effect.retry(conflictRetry),
          Effect.catchTag("NotFound", () => Effect.void),
        );
      yield* waitUntilGone({
        resource: `STACKIT security group ${output.securityGroupId} on server ${output.serverId}`,
        read: isAttached(scope, output.serverId, output.securityGroupId).pipe(
          Effect.map((attached) => (attached ? "attached" : undefined)),
        ),
        timeout: "1 minute",
      });
    }),
  });
