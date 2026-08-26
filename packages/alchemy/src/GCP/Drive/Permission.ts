import * as drive from "@distilled.cloud/gcp/drive_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  findPermission,
  getPermission,
  ignoreMissing,
  isManagedPermission,
  listManagedPermissions,
  sameBoolean,
  sameText,
} from "./internal.ts";

export type PermissionProps = {
  /**
   * Parent file or shared-drive id. Immutable — changing it replaces
   * the permission.
   */
  fileId: string;
  /**
   * Drive-assigned permission id. Server-assigned on create. Immutable
   * — changing it replaces the permission.
   */
  permissionId?: string;
  /**
   * Grantee type (`user`, `group`, `domain`, or `anyone`). Immutable —
   * changing it replaces the permission.
   */
  type: string;
  /**
   * Role (`owner`, `organizer`, `fileOrganizer`, `writer`,
   * `commenter`, or `reader`).
   */
  role: string;
  /**
   * Email for `user` or `group` permissions. Immutable — changing it
   * replaces the permission.
   */
  emailAddress?: string;
  /**
   * Domain for `domain` permissions. Immutable — changing it replaces
   * the permission.
   */
  domain?: string;
  /**
   * Whether `domain` or `anyone` permissions are discoverable via
   * search.
   */
  allowFileDiscovery?: boolean;
  /**
   * RFC3339 expiration. User and group permissions only.
   */
  expirationTime?: string;
  /**
   * Pending owner flag. User permissions on My Drive files only.
   */
  pendingOwner?: boolean;
  /**
   * Send a notification email when sharing with a user or group.
   * Create-only.
   * @default false
   */
  sendNotificationEmail?: boolean;
  /**
   * Custom message included in the notification email. Create-only.
   */
  emailMessage?: string;
  /**
   * Transfer ownership to the specified user. Required as an
   * acknowledgement when `role` is `owner`.
   */
  transferOwnership?: boolean;
};

export type Permission = Resource<
  "GCP.Drive.Permission",
  PermissionProps,
  {
    /** Drive-assigned permission id. */
    permissionId: string;
    /** Parent file or shared-drive id. */
    fileId: string;
    /** Project id used when the permission was reconciled. */
    project: string;
    /** Grantee type. */
    type: string | undefined;
    /** Role. */
    role: string | undefined;
    /** Email, when the grantee is a user or group. */
    emailAddress: string | undefined;
    /** Domain, when the grantee is a domain. */
    domain: string | undefined;
    /** Display name, when returned. */
    displayName: string | undefined;
    /** Whether the permission is discoverable. */
    allowFileDiscovery: boolean | undefined;
    /** RFC3339 expiration. */
    expirationTime: string | undefined;
    /** Pending owner flag. */
    pendingOwner: boolean | undefined;
    /** Whether the grantee account is deleted. */
    deleted: boolean;
  },
  never,
  Providers
>;

/**
 * A permission on a Google Drive file or shared drive.
 *
 * Permissions have no labels or description, so Alchemy lists
 * non-owner, non-inherited permissions on alchemy-owned files for
 * `list` / nuke. Parent file, type, and email/domain are identity —
 * changing them replaces the permission. Role, expiration, and
 * discovery update in place.
 *
 * ### Creating a Permission
 * **Example:** Anyone with the link can read
 * ```typescript
 * const permission = yield* GCP.Drive.Permission("Public", {
 *   fileId: file.fileId,
 *   type: "anyone",
 *   role: "reader",
 * });
 * ```
 *
 * **Example:** Share with a user
 * ```typescript
 * const permission = yield* GCP.Drive.Permission("Ada", {
 *   fileId: file.fileId,
 *   type: "user",
 *   role: "writer",
 *   emailAddress: "ada@example.com",
 *   sendNotificationEmail: false,
 * });
 * ```
 *
 * ### Updating a Permission
 * **Example:** Promote to commenter
 * ```typescript
 * const permission = yield* GCP.Drive.Permission("Public", {
 *   fileId: existing.fileId,
 *   permissionId: existing.permissionId,
 *   type: "anyone",
 *   role: "commenter",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Drive
 */
export const Permission = Resource<Permission>("GCP.Drive.Permission");

export class PermissionNotResolved extends Data.TaggedError(
  "GCP.Drive.PermissionNotResolved",
)<{
  fileId: string;
  permissionId: string;
}> {}

const toAttrs = (
  permission: drive.Permission,
  fileId: string,
  project: string,
) => ({
  permissionId: permission.id ?? "",
  fileId,
  project,
  type: permission.type,
  role: permission.role,
  emailAddress: permission.emailAddress,
  domain: permission.domain,
  displayName: permission.displayName,
  allowFileDiscovery: permission.allowFileDiscovery,
  expirationTime: permission.expirationTime,
  pendingOwner: permission.pendingOwner,
  deleted: permission.deleted === true,
});

export const PermissionProvider = () =>
  Provider.succeed(Permission, {
    stables: ["permissionId", "fileId", "project", "type"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousFile = olds?.fileId ?? output?.fileId;
      if (previousFile !== undefined && news.fileId !== previousFile) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousId = olds?.permissionId ?? output?.permissionId;
      if (
        previousId !== undefined &&
        news.permissionId !== undefined &&
        news.permissionId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousType = olds?.type ?? output?.type;
      if (previousType !== undefined && news.type !== previousType) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousEmail = olds?.emailAddress ?? output?.emailAddress;
      if (
        news.emailAddress !== undefined &&
        previousEmail !== undefined &&
        news.emailAddress.toLowerCase() !== previousEmail.toLowerCase()
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousDomain = olds?.domain ?? output?.domain;
      if (
        news.domain !== undefined &&
        previousDomain !== undefined &&
        news.domain.toLowerCase() !== previousDomain.toLowerCase()
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const fileId = olds?.fileId ?? output?.fileId ?? "";
      const existing = yield* findPermission(fileId, {
        permissionId: olds?.permissionId ?? output?.permissionId,
        type: olds?.type ?? output?.type,
        emailAddress: olds?.emailAddress ?? output?.emailAddress,
        domain: olds?.domain ?? output?.domain,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, fileId, env.project);
      return output !== undefined || isManagedPermission(existing)
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const permissions = yield* listManagedPermissions();
        return permissions.map((permission) =>
          toAttrs(permission, permission.fileId, env.project),
        );
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const fileId = news.fileId;
      const desired: drive.Permission = {
        type: news.type,
        role: news.role,
        emailAddress: news.emailAddress,
        domain: news.domain,
        allowFileDiscovery: news.allowFileDiscovery,
        expirationTime: news.expirationTime,
        pendingOwner: news.pendingOwner,
      };

      let current = yield* findPermission(fileId, {
        permissionId: news.permissionId ?? output?.permissionId,
        type: news.type,
        emailAddress: news.emailAddress,
        domain: news.domain,
      });

      if (current === undefined) {
        const created = yield* drive
          .createPermissions({
            fileId,
            supportsAllDrives: true,
            sendNotificationEmail: news.sendNotificationEmail ?? false,
            emailMessage: news.emailMessage,
            transferOwnership: news.transferOwnership,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findPermission(fileId, {
                permissionId: news.permissionId ?? output?.permissionId,
                type: news.type,
                emailAddress: news.emailAddress,
                domain: news.domain,
              }),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new PermissionNotResolved({
          fileId,
          permissionId: news.permissionId ?? output?.permissionId ?? "",
        });
      }

      const permissionId =
        current.id ?? news.permissionId ?? output?.permissionId ?? "";
      const roleChanged =
        news.role !== undefined && !sameText(current.role, news.role);
      const discoveryChanged =
        news.allowFileDiscovery !== undefined &&
        !sameBoolean(current.allowFileDiscovery, news.allowFileDiscovery);
      const expirationChanged =
        news.expirationTime !== undefined &&
        !sameText(current.expirationTime, news.expirationTime);
      const pendingChanged =
        news.pendingOwner !== undefined &&
        !sameBoolean(current.pendingOwner, news.pendingOwner);

      if (
        roleChanged ||
        discoveryChanged ||
        expirationChanged ||
        pendingChanged
      ) {
        current = yield* drive.updatePermissions({
          fileId,
          permissionId,
          supportsAllDrives: true,
          transferOwnership: news.transferOwnership,
          body: {
            role: news.role,
            allowFileDiscovery: news.allowFileDiscovery,
            expirationTime: news.expirationTime,
            pendingOwner: news.pendingOwner,
          },
        });
      }

      const fresh = yield* getPermission(fileId, permissionId);
      return toAttrs(fresh ?? current, fileId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.fileId.length === 0 || output.permissionId.length === 0) {
        return;
      }
      yield* ignoreMissing(
        drive.deletePermissions({
          fileId: output.fileId,
          permissionId: output.permissionId,
          supportsAllDrives: true,
        }),
      );
    }),
  });
