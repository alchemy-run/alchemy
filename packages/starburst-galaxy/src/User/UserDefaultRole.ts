import * as galaxy from "@distilled.cloud/starburst-galaxy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import { getUser } from "./User.ts";

export interface UserDefaultRoleProps {
  /**
   * ID of the user (`u-…`), e.g. from `StarburstGalaxy.User.User.lookup` or a
   * `ServiceAccount`'s `serviceAccountId`. Changing it replaces the
   * resource: the old user's default role is restored.
   */
  readonly user: string;
  /**
   * ID of the role the user's sessions start with. The user must hold the
   * role (directly, through `RoleGrant`, or as a service account's role).
   */
  readonly role: string;
}

export interface UserDefaultRoleAttributes {
  /** The user whose default role is set. */
  readonly userId: string;
  /** The default role this resource set. */
  readonly roleId: string;
  /**
   * The user's default role before this resource first set it; restored on
   * delete. `undefined` when the user had none.
   */
  readonly baselineRoleId: string | undefined;
}

export type UserDefaultRole = Resource<
  "StarburstGalaxy.User.UserDefaultRole",
  UserDefaultRoleProps,
  UserDefaultRoleAttributes,
  never,
  Providers
>;

/** The user a `UserDefaultRole` names does not exist. */
export class UserNotFound extends Data.TaggedError("StarburstGalaxy.UserNotFound")<{
  readonly userId: string;
}> {
  override get message() {
    return `Starburst Galaxy user ${this.userId} does not exist`;
  }
}

/**
 * The default role of an existing Starburst Galaxy user: the role a
 * user's SQL sessions and API calls start with (Galaxy's `defaultRoleId`).
 *
 * It manages one setting of a user the stack does not own. The first
 * deploy records the user's current default role, and `destroy` restores
 * it, so removing the resource leaves the user as it was. Changing `role`
 * updates in place; changing `user` restores the old user and sets the
 * new one.
 *
 * Galaxy only accepts a role the user already holds: grant it first with
 * `StarburstGalaxy.Role.RoleGrant` (or as a service account's role) and pass the
 * grant's `roleId`, so the default is set after the grant.
 *
 * @see https://docs.starburst.io/starburst-galaxy/security-and-compliance/manage-galaxy-access/manage-users-roles-and-tags/roles.html
 *
 * ### Setting a default role
 * **Example:** A service account starts its sessions as its reporting role
 * ```typescript
 * const etl = yield* StarburstGalaxy.Role.Role("Etl", {});
 * const reporting = yield* StarburstGalaxy.Role.Role("Reporting", {});
 * const account = yield* StarburstGalaxy.ServiceAccount.ServiceAccount("Pipeline", {
 *   role: etl.roleId,
 *   additionalRoles: [reporting.roleId],
 * });
 * yield* StarburstGalaxy.User.UserDefaultRole("PipelineDefault", {
 *   user: account.serviceAccountId,
 *   role: reporting.roleId,
 * });
 * ```
 *
 * **Example:** A person's default role, granted in the same stack
 * ```typescript
 * const ada = StarburstGalaxy.User.User.lookup({ email: "ada@example.com" });
 * const analysts = yield* StarburstGalaxy.Role.Role("Analysts", {});
 * const grant = yield* StarburstGalaxy.Role.RoleGrant("AdaIsAnalyst", {
 *   role: analysts.roleId,
 *   principal: { type: "User", userId: ada.userId },
 * });
 * yield* StarburstGalaxy.User.UserDefaultRole("AdaDefault", {
 *   user: ada.userId,
 *   role: grant.roleId,
 * });
 * ```
 *
 * @resource
 * @product Access
 */
export const UserDefaultRole = Resource<UserDefaultRole>("StarburstGalaxy.User.UserDefaultRole");

const setDefaultRole = (userId: string, roleId: string) =>
  galaxy.user.updateUser({ userId, roleId });

export const UserDefaultRoleProvider = () =>
  Provider.succeed(UserDefaultRole, {
    stables: ["userId", "baselineRoleId"],

    // Not listed: the setting belongs to a user the stack does not own, and
    // only state knows the baseline to restore.
    nuke: { skip: true },

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      if (news.user !== olds.user) return { action: "replace" } as const;
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      // Ownership and the baseline live in state only.
      if (output === undefined) return undefined;
      const user = yield* getUser(output.userId);
      if (user === undefined) return undefined;
      return { ...output, roleId: user.defaultRoleId ?? "" };
    }),

    reconcile: Effect.fn(function* ({ news, output, session }) {
      const user = yield* getUser(news.user);
      if (user === undefined) return yield* new UserNotFound({ userId: news.user });
      // The first write records what to restore; a later one keeps it.
      const baselineRoleId = output !== undefined ? output.baselineRoleId : user.defaultRoleId;
      if (user.defaultRoleId !== news.role) {
        yield* session.note(`Setting the default role of ${user.email}...`);
        yield* setDefaultRole(news.user, news.role);
      }
      return { userId: news.user, roleId: news.role, baselineRoleId };
    }),

    delete: Effect.fn(function* ({ output }) {
      const user = yield* getUser(output.userId);
      // A user that is gone, or whose default someone else changed since, is left alone.
      if (user === undefined || user.defaultRoleId !== output.roleId) return;
      if (output.baselineRoleId === undefined || output.baselineRoleId === output.roleId) return;
      yield* setDefaultRole(output.userId, output.baselineRoleId);
    }),

    list: () => Effect.succeed([]),
  });
