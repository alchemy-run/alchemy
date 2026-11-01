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

export interface ServerServiceAccountAttachmentProps extends ProjectScopedProps {
  /** Server to attach the service account to. Changing it replaces the attachment. */
  serverId: string;
  /**
   * E-mail of the service account (`IAM.ServiceAccount`'s `email`). Changing
   * it replaces the attachment.
   */
  serviceAccountEmail: string;
  /**
   * Project of the server. Defaults to the profile's project. Changing it
   * replaces the attachment.
   */
  projectId?: string;
  /**
   * Region of the server. Defaults to the profile's region. Changing it
   * replaces the attachment.
   */
  region?: string;
}

export interface ServerServiceAccountAttachmentAttributes {
  /** Server the service account is attached to. */
  serverId: string;
  /** E-mail of the attached service account. */
  serviceAccountEmail: string;
  /** Project of the attachment. */
  projectId: string;
  /** Region of the attachment. */
  region: string;
}

export type ServerServiceAccountAttachment = Resource<
  "Stackit.IaaS.ServerServiceAccountAttachment",
  ServerServiceAccountAttachmentProps,
  ServerServiceAccountAttachmentAttributes,
  never,
  Providers
>;

/**
 * Attaches a STACKIT service account to a server, so software on the
 * server can obtain tokens for that account from the metadata service
 * instead of storing a key.
 *
 * Existence-only: identified by the server id and service account e-mail,
 * nothing to update. STACKIT allows one service account per server.
 * Attachments carry no labels; Alchemy tracks them by the pair in state,
 * and a deploy without state takes over an existing attachment of the same
 * pair.
 *
 * ### Giving a server an identity
 * **Example:** Attach a service account to a server
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const identity = yield* Stackit.IAM.ServiceAccount("Worker", {});
 * const server = yield* Stackit.IaaS.Server("Worker", {
 *   machineType: "g1.1",
 *   bootVolume: { size: 20, source: { type: "image", id: "<image id>" } },
 *   networking: { networkId: network.networkId },
 * });
 * yield* Stackit.IaaS.ServerServiceAccountAttachment("Worker", {
 *   serverId: server.serverId,
 *   serviceAccountEmail: identity.email,
 * });
 * ```
 *
 * ### Replacement
 * Changing `serverId`, `serviceAccountEmail`, `projectId` or `region`
 * detaches the account and attaches the new pair; since a server holds one
 * account, the old attachment is removed first.
 *
 * @resource
 * @product STACKIT Compute Engine
 * @category IaaS
 */
export const ServerServiceAccountAttachment = Resource<ServerServiceAccountAttachment>(
  "Stackit.IaaS.ServerServiceAccountAttachment",
);

/** Whether the account is attached (`false` when the server is gone). */
const isAttached = (scope: ProjectScope, serverId: string, serviceAccountEmail: string) =>
  iaas.listServerServiceAccounts({ ...scope, serverId }).pipe(
    Effect.map(({ items }) => items.includes(serviceAccountEmail)),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

const toAttrs = (
  scope: ProjectScope,
  ids: { serverId: string; serviceAccountEmail: string },
): ServerServiceAccountAttachmentAttributes => ({ ...ids, ...scope });

export const ServerServiceAccountAttachmentProvider = () =>
  Provider.succeed(ServerServiceAccountAttachment, {
    stables: ["serverId", "serviceAccountEmail", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.IaaS.Server", "Stackit.IAM.ServiceAccount"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      // One service account per server: the old attachment goes first.
      if (yield* projectScopeChanged(news, output)) {
        return { action: "replace", deleteFirst: true } as const;
      }
      if (
        news.serverId !== output.serverId ||
        news.serviceAccountEmail !== output.serviceAccountEmail
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      // No ownership marker: without a recorded pair, reconcile takes over
      // an existing attachment instead.
      if (output === undefined) return undefined;
      const scope = { projectId: output.projectId, region: output.region };
      const attached = yield* isAttached(scope, output.serverId, output.serviceAccountEmail);
      return attached ? toAttrs(scope, output) : undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const ids = { serverId: news.serverId, serviceAccountEmail: news.serviceAccountEmail };

      // Observe, then ensure. `Conflict` while the server is busy.
      if (!(yield* isAttached(scope, ids.serverId, ids.serviceAccountEmail))) {
        yield* iaas
          .addServiceAccountToServer({
            ...scope,
            serverId: ids.serverId,
            serviceAccountMail: ids.serviceAccountEmail,
          })
          .pipe(Effect.retry(conflictRetry));
        yield* waitFor({
          resource: `STACKIT service account ${ids.serviceAccountEmail} on server ${ids.serverId}`,
          read: isAttached(scope, ids.serverId, ids.serviceAccountEmail),
          ready: (attached) => attached,
          timeout: "1 minute",
        });
      }
      return toAttrs(scope, ids);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      yield* iaas
        .removeServiceAccountFromServer({
          ...scope,
          serverId: output.serverId,
          serviceAccountMail: output.serviceAccountEmail,
        })
        .pipe(
          Effect.retry(conflictRetry),
          Effect.catchTag("NotFound", () => Effect.void),
        );
      yield* waitUntilGone({
        resource: `STACKIT service account ${output.serviceAccountEmail} on server ${output.serverId}`,
        read: isAttached(scope, output.serverId, output.serviceAccountEmail).pipe(
          Effect.map((attached) => (attached ? "attached" : undefined)),
        ),
        timeout: "1 minute",
      });
    }),
  });
