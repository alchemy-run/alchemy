import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type { Group as GroupShape } from "@distilled.cloud/starburst-galaxy/group";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { findFirst } from "../internal.ts";
import { lookupOnlyLifecycle } from "../LookupOnly.ts";
import type { Providers } from "../Providers.ts";

/** Find a Galaxy group by name or ID. */
export type GroupLookup =
  | {
      /** The group's name, as the identity provider sends it. */
      readonly name: string;
    }
  | {
      /** The group's ID. */
      readonly groupId: string;
    };

export interface GroupAttributes {
  /** Galaxy's group ID. */
  readonly groupId: string;
  /** The group's name. */
  readonly name: string;
  /** The identity provider's ID for the group (SCIM `externalId`). */
  readonly externalId: string;
  /** Roles granted to the group. */
  readonly roles: ReadonlyArray<{ readonly roleId: string; readonly roleName: string }>;
  /** Users in the group. */
  readonly users: ReadonlyArray<{ readonly userId: string; readonly email: string }>;
}

export type Group = Resource<
  "StarburstGalaxy.Group",
  GroupLookup,
  GroupAttributes,
  never,
  Providers,
  GroupLookup
>;

/**
 * A group of users in a Starburst Galaxy account, provisioned by an
 * identity provider over SCIM (Okta, Microsoft Entra ID, …). Grant a
 * stack-owned role to every member with `StarburstGalaxy.RoleGrant`.
 *
 * Groups are only looked up: Galaxy's API cannot create or delete one,
 * since the identity provider owns them. Declaring
 * `StarburstGalaxy.Group(...)` in a stack fails with
 * `StarburstGalaxy.LookupOnlyResource`.
 *
 * @see https://docs.starburst.io/starburst-galaxy/security-and-compliance/manage-galaxy-access/manage-sso-integration/groups.html
 *
 * ### Looking up a group
 * **Example:** Give every analyst a stack-owned role
 * ```typescript
 * const analystsGroup = StarburstGalaxy.Group.lookup({ name: "analysts" });
 * const reporting = yield* StarburstGalaxy.Role("Reporting", {});
 * yield* StarburstGalaxy.RoleGrant("AnalystsReport", {
 *   role: reporting.roleId,
 *   principal: { type: "Group", groupId: analystsGroup.groupId },
 * });
 * ```
 *
 * @resource
 * @product Access
 */
export const Group = Resource<Group>("StarburstGalaxy.Group");

const toAttributes = (group: GroupShape): GroupAttributes => ({
  groupId: group.groupId,
  name: group.groupName,
  externalId: group.externalId,
  roles: group.roles.map((role) => ({ roleId: role.roleId, roleName: role.roleName })),
  users: group.users.map((user) => ({ userId: user.userId, email: user.email })),
});

/** A group by ID, from the list (Galaxy has no get-group operation). */
export const findGroup = (groupId: string) =>
  findFirst(galaxy.group.listGroups.items({}), (group) => group.groupId === groupId);

export const GroupProvider = () =>
  Provider.succeed(Group, {
    ...lookupOnlyLifecycle(
      "StarburstGalaxy.Group",
      "groups come from the identity provider over SCIM; Galaxy's API cannot create one",
    ),
    lookup: Effect.fn(function* (key) {
      const group =
        "groupId" in key
          ? yield* findGroup(key.groupId)
          : yield* findFirst(galaxy.group.listGroups.items({}), (g) => g.groupName === key.name);
      return group === undefined ? undefined : toAttributes(group);
    }),
  });
