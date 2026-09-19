import * as dfa from "@distilled.cloud/gcp/dfareporting_v5";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  findRoleByName,
  getRole,
  hasOwnershipMarker,
  listProfiles,
  listRoles,
  ownedByAlchemy,
  parseOwnership,
  permissionsOf,
  resolveParentUserRoleId,
  samePermissions,
  sameText,
  toPermissionBody,
  toRoleName,
  type UserRolePermissionValue,
} from "./internal.ts";

export type { UserRolePermissionValue };

export type UserRoleProps = {
  /**
   * Campaign Manager 360 user profile id used to authorize the request.
   * Immutable — changing it replaces the user role.
   */
  profileId: string;
  /**
   * System-assigned user role id. Omit on create; pass the observed id
   * to update in place. Immutable — changing it replaces the role.
   */
  userRoleId?: string;
  /**
   * User-facing role name (less than 256 characters). Unique among
   * top-level roles of the same account, or among subaccount roles of
   * the same subaccount. If omitted, a unique name is generated.
   * User roles have no labels field, so Alchemy ownership is stored in
   * a `[alchemy …]` prefix and stripped from attributes.
   */
  name?: string;
  /**
   * Id of the user role this role is based on or copied from. Required
   * on create. If omitted, Alchemy uses a default account-level role
   * when one is visible to `profileId`.
   */
  parentUserRoleId?: string;
  /**
   * Permissions granted to this role. A subset of the parent role's
   * permissions. Omit to keep the API default (copied from the parent
   * on create).
   */
  permissions?: UserRolePermissionValue[];
};

export type UserRole = Resource<
  "GCP.Dfareporting.UserRole",
  UserRoleProps,
  {
    /** System-assigned user role id. */
    userRoleId: string;
    /** User profile id used to manage this role. */
    profileId: string;
    /** User-facing name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
    /** Parent user role id. */
    parentUserRoleId: string | undefined;
    /** Whether this is a system default role. */
    defaultUserRole: boolean;
    /** Account id. */
    accountId: string | undefined;
    /** Subaccount id, if any. */
    subaccountId: string | undefined;
    /** Assigned permissions. */
    permissions: UserRolePermissionValue[];
    /** Resource kind (`dfareporting#userRole`). */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Campaign Manager 360 user role.
 *
 * User roles have no labels field — Alchemy stamps ownership into the
 * name so `list` / nuke can find them. `profileId` and `userRoleId` are
 * identity. Name and permissions update in place. Default system roles
 * cannot be modified or deleted.
 *
 * ### Creating a User Role
 * **Example:** Role copied from a parent
 * ```typescript
 * const role = yield* GCP.Dfareporting.UserRole("Analyst", {
 *   profileId,
 *   parentUserRoleId,
 *   name: "analyst",
 * });
 * ```
 *
 * **Example:** Role with an explicit permission list
 * ```typescript
 * const role = yield* GCP.Dfareporting.UserRole("Analyst", {
 *   profileId,
 *   parentUserRoleId,
 *   name: "analyst",
 *   permissions: [{ id: permissionId }],
 * });
 * ```
 *
 * ### Updating a User Role
 * **Example:** Rename
 * ```typescript
 * const role = yield* GCP.Dfareporting.UserRole("Analyst", {
 *   profileId,
 *   userRoleId: existing.userRoleId,
 *   parentUserRoleId: existing.parentUserRoleId,
 *   name: "analyst-v2",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Dfareporting
 */
export const UserRole = Resource<UserRole>("GCP.Dfareporting.UserRole");

export class UserRoleNotResolved extends Data.TaggedError(
  "GCP.Dfareporting.UserRoleNotResolved",
)<{
  profileId: string;
  userRoleId: string;
}> {}

export class UserRoleParentNotFound extends Data.TaggedError(
  "GCP.Dfareporting.UserRoleParentNotFound",
)<{
  profileId: string;
}> {}

const toAttrs = (role: dfa.UserRole, profileId: string) => {
  const parsed = parseOwnership(role.name);
  return {
    userRoleId: role.id ?? "",
    profileId,
    name: parsed.text,
    parentUserRoleId: role.parentUserRoleId,
    defaultUserRole: role.defaultUserRole === true,
    accountId: role.accountId,
    subaccountId: role.subaccountId,
    permissions: permissionsOf(role.permissions),
    kind: role.kind,
  };
};

const isDeletable = (role: dfa.UserRole) => role.defaultUserRole !== true;

export const UserRoleProvider = () =>
  Provider.succeed(UserRole, {
    stables: ["userRoleId", "profileId", "accountId", "subaccountId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousProfile = olds?.profileId ?? output?.profileId;
      if (previousProfile !== undefined && news.profileId !== previousProfile) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.userRoleId ?? output?.userRoleId;
      if (
        previousId !== undefined &&
        news.userRoleId !== undefined &&
        news.userRoleId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const profileId = olds?.profileId ?? output?.profileId;
      let existing = yield* getRole(
        profileId,
        olds?.userRoleId ?? output?.userRoleId,
      );
      if (existing === undefined && profileId !== undefined) {
        const ownership = yield* createInternalLabels(id);
        const name = encodeOwnershipLine(
          ownership,
          parseOwnership(olds?.name ?? output?.name).text,
        );
        existing = yield* findRoleByName(profileId, name);
      }
      if (existing === undefined || profileId === undefined) return undefined;
      const attrs = toAttrs(existing, profileId);
      if (!isDeletable(existing)) return Unowned(attrs);
      return (yield* ownedByAlchemy(id, existing.name))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const profiles = yield* listProfiles();
        const pages = yield* Effect.forEach(
          profiles,
          (profile) =>
            listRoles(profile.profileId, { searchString: "alchemy" }).pipe(
              Effect.map((roles) =>
                roles
                  .filter(
                    (role) =>
                      isDeletable(role) && hasOwnershipMarker(role.name),
                  )
                  .map((role) => toAttrs(role, profile.profileId)),
              ),
            ),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const profileId = news.profileId;
      const ownership = yield* createInternalLabels(id);
      const userName = yield* toRoleName(
        id,
        news.name,
        parseOwnership(output?.name).text,
      );
      const name = encodeOwnershipLine(ownership, userName);
      const parentUserRoleId = yield* resolveParentUserRoleId(
        profileId,
        news.parentUserRoleId,
        output?.parentUserRoleId,
      );
      const permissions = toPermissionBody(news.permissions);

      let current = yield* getRole(
        profileId,
        news.userRoleId ?? output?.userRoleId,
      );
      if (current === undefined) {
        current = yield* findRoleByName(profileId, name);
      }

      if (current === undefined) {
        if (parentUserRoleId === undefined) {
          return yield* new UserRoleParentNotFound({ profileId });
        }
        const created = yield* dfa
          .insertUserRoles({
            profileId,
            body: {
              name,
              parentUserRoleId,
              permissions,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () => findRoleByName(profileId, name)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new UserRoleNotResolved({
          profileId,
          userRoleId: news.userRoleId ?? output?.userRoleId ?? name,
        });
      }

      const userRoleId = current.id ?? "";
      const nameChanged = !sameText(current.name, name);
      const parentChanged =
        parentUserRoleId !== undefined &&
        !sameText(current.parentUserRoleId, parentUserRoleId);
      const permissionsChanged =
        news.permissions !== undefined &&
        !samePermissions(current.permissions, news.permissions);

      if (nameChanged || parentChanged || permissionsChanged) {
        current = yield* dfa.patchUserRoles({
          profileId,
          id: userRoleId,
          body: {
            id: userRoleId,
            ...(nameChanged ? { name } : {}),
            ...(parentChanged ? { parentUserRoleId } : {}),
            ...(permissionsChanged ? { permissions } : {}),
          },
        });
      }

      return toAttrs(current, profileId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.userRoleId || !output.profileId || output.defaultUserRole) {
        return;
      }
      yield* dfa
        .deleteUserRoles({
          profileId: output.profileId,
          id: output.userRoleId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
