import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type { User as UserShape } from "@distilled.cloud/starburst-galaxy/user";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { findFirst } from "../internal.ts";
import { lookupOnlyLifecycle } from "../LookupOnly.ts";
import type { Providers } from "../Providers.ts";

/** Find a Galaxy user by sign-in email, or by ID (service accounts included). */
export type UserLookup =
  | {
      /** The user's sign-in email. Service accounts are not listed by email; use `userId`. */
      readonly email: string;
    }
  | {
      /** The user's ID (`u-…`); a `ServiceAccount`'s `serviceAccountId` is one. */
      readonly userId: string;
    };

/** A role granted to a user, as Galaxy reports it. */
export interface UserRoleGrant {
  /** ID of the granted role. */
  readonly roleId: string;
  /** Name of the granted role. */
  readonly roleName: string;
  /** Whether the user may grant the role on. */
  readonly adminOption: boolean;
}

export interface UserAttributes {
  /** Galaxy's user ID (`u-…`). */
  readonly userId: string;
  /** Sign-in email; `<name>@<account domain>` for a service account. */
  readonly email: string;
  /** ID of the role the user's sessions start with. */
  readonly defaultRoleId: string | undefined;
  /** Whether the user is provisioned by SCIM from an identity provider. */
  readonly scimManaged: boolean;
  /** Roles granted to the user directly (not through other roles or groups). */
  readonly directlyGrantedRoles: ReadonlyArray<UserRoleGrant>;
  /** When the user was created. */
  readonly createdOn: string;
}

export type User = Resource<
  "StarburstGalaxy.User.User",
  UserLookup,
  UserAttributes,
  never,
  Providers,
  UserLookup
>;

/**
 * A person (or service account) in a Starburst Galaxy account, found by
 * email or ID: pass `userId` to `RoleGrant`, `UserDefaultRole`, or a data
 * product's contacts.
 *
 * Users are only looked up. Galaxy's API can invite a user by email but has
 * no operation to remove one, so a user Alchemy invited would outlive every
 * `destroy`. Declaring `StarburstGalaxy.User.User(...)` in a stack fails with
 * `StarburstGalaxy.LookupOnlyResource`.
 *
 * @see https://docs.starburst.io/starburst-galaxy/security-and-compliance/manage-galaxy-access/manage-users-roles-and-tags/manage-users-without-sso.html
 *
 * ### Looking up a user
 * **Example:** Grant a stack-owned role to an existing person
 * ```typescript
 * const ada = StarburstGalaxy.User.User.lookup({ email: "ada@example.com" });
 * const analysts = yield* StarburstGalaxy.Role.Role("Analysts", {});
 * yield* StarburstGalaxy.Role.RoleGrant("AdaIsAnalyst", {
 *   role: analysts.roleId,
 *   principal: { type: "User", userId: ada.userId },
 * });
 * ```
 *
 * **Example:** A service account, by ID
 * ```typescript
 * const etl = yield* StarburstGalaxy.ServiceAccount.ServiceAccount("Etl", { role: analystsRoleId });
 * const etlUser = StarburstGalaxy.User.User.lookup({ userId: etl.serviceAccountId });
 * ```
 *
 * @resource
 * @product Access
 */
export const User = Resource<User>("StarburstGalaxy.User.User");

/** A user's attributes from Galaxy's shape. */
export const userAttributes = (user: UserShape): UserAttributes => ({
  userId: user.userId,
  email: user.email,
  defaultRoleId: user.defaultRoleId,
  scimManaged: user.scimManaged,
  directlyGrantedRoles: user.directlyGrantedRoles.map((grant) => ({
    roleId: grant.roleId,
    roleName: grant.roleName,
    adminOption: grant.adminOption,
  })),
  createdOn: user.createdOn,
});

/** A user by ID; `undefined` when Galaxy reports `NotFound`. */
export const getUser = (userId: string) =>
  galaxy.user.getUser({ userId }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const UserProvider = () =>
  Provider.succeed(User, {
    ...lookupOnlyLifecycle(
      "StarburstGalaxy.User.User",
      "Galaxy has no operation to remove a user, so an invited user would outlive the stack",
    ),
    lookup: Effect.fn(function* (key) {
      // Galaxy's `email=` id lookup is refused (`Invalid id`), so emails are matched on the list.
      const user =
        "userId" in key
          ? yield* getUser(key.userId)
          : yield* findFirst(
              galaxy.user.listUsers.items({}),
              (user) => user.email.toLowerCase() === key.email.toLowerCase(),
            );
      return user === undefined ? undefined : userAttributes(user);
    }),
  });
