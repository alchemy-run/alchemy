import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
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

export interface ServerServiceAccountAttachmentProps extends ProjectScopedProps {
  /** Server to attach the service account to. Changing it replaces the attachment. */
  serverId: string;
  /**
   * E-mail of the service account (`IAM.ServiceAccount`'s `email`). Changing
   * it replaces the attachment.
   */
  serviceAccountEmail: string;
  /**
   * Fail straight away when the server has another account attached, rather
   * than trying to attach this one. A binding that needs the server to run as
   * this account sets it, because a program there can't be given a second one.
   * @default false
   */
  exclusive?: boolean;
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

/** The server has another service account attached, and holds one at a time. */
export class ServerServiceAccountTaken extends Data.TaggedError(
  "Stackit.IaaS.ServerServiceAccountTaken",
)<{
  readonly serverId: string;
  readonly serviceAccountEmail: string;
  readonly attached: string;
  readonly message: string;
}> {}

/**
 * Attaches a STACKIT service account to a server, so software on the
 * server can obtain tokens for that account from the metadata service
 * instead of storing a key.
 *
 * Existence-only: identified by the server id and service account e-mail,
 * nothing to update. STACKIT allows one service account per server.
 * Attachments carry no labels; Alchemy tracks them by the pair in state,
 * and a deploy without state takes over an existing attachment of the same
 * pair. A server that already holds another account fails the deploy with
 * `Stackit.IaaS.ServerServiceAccountTaken`, which names it.
 *
 * See [STACKIT's Server docs](https://docs.stackit.cloud/products/compute-engine/server/).
 *
 * :::caution[Changing `serverId`, `serviceAccountEmail`, `projectId` or `region` replaces the Attachment]
 * A deploy detaches the account and attaches the new pair; since a server holds one
 * account, the old attachment is removed first.
 * :::
 *
 * ### Giving a server an identity
 * **Example:** Attach a service account to a server
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const identity = yield* Stackit.IAM.ServiceAccount("WorkerAccount", {});
 * const server = yield* Stackit.IaaS.Server("Worker", {
 *   machineType: "g1.1",
 *   bootVolume: { size: 20, source: { type: "image", id: "<image id>" } },
 *   networking: { networkId: network.networkId },
 * });
 * yield* Stackit.IaaS.ServerServiceAccountAttachment("WorkerAttachment", {
 *   serverId: server.serverId,
 *   serviceAccountEmail: identity.email,
 * });
 * ```
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

/** Another account on the server, as a typed failure; nothing when there is none. */
const failIfTaken = (scope: ProjectScope, ids: { serverId: string; serviceAccountEmail: string }) =>
  iaas.listServerServiceAccounts({ ...scope, serverId: ids.serverId }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed({ items: [] as string[] })),
    Effect.flatMap(({ items }) => {
      const attached = items.find((email) => email !== ids.serviceAccountEmail);
      return attached === undefined
        ? Effect.void
        : Effect.fail(
            new ServerServiceAccountTaken({
              ...ids,
              attached,
              message: `Server ${ids.serverId} already has service account ${attached} attached, and holds one at a time, so ${ids.serviceAccountEmail} can't be. Remove the other attachment. A binding on a program running on this server attaches its own account, and can't share the server with one you attach.`,
            }),
          );
    }),
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
      if (output === undefined) return undefined;
      // One service account per server: the old attachment goes first.
      if (
        hasUnresolvedTrigger<ServerServiceAccountAttachmentProps>(news, [
          "projectId",
          "region",
          "serverId",
          "serviceAccountEmail",
        ])
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<ServerServiceAccountAttachmentProps>(news);
      if (yield* projectScopeChanged(resolved, output)) {
        return { action: "replace", deleteFirst: true } as const;
      }
      if (
        resolved.serverId !== output.serverId ||
        resolved.serviceAccountEmail !== output.serviceAccountEmail
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

      // Observe, then ensure. `Conflict` while the server is busy, or, after the retries, because
      // another attachment won a race to the server's one place, which is worth naming.
      if (!(yield* isAttached(scope, ids.serverId, ids.serviceAccountEmail))) {
        if (news.exclusive === true) yield* failIfTaken(scope, ids);
        yield* iaas
          .addServiceAccountToServer({
            ...scope,
            serverId: ids.serverId,
            serviceAccountMail: ids.serviceAccountEmail,
          })
          .pipe(
            Effect.retry(conflictRetry),
            Effect.catchTag("Conflict", (error) =>
              failIfTaken(scope, ids).pipe(Effect.andThen(Effect.fail(error))),
            ),
          );
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
