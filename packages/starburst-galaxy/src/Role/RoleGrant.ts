import * as galaxy from "@distilled.cloud/starburst-galaxy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { Providers } from "../Providers.ts";
import { findGroup } from "../User/Group.ts";
import { getUser } from "../User/User.ts";

/** Who a role is granted to. */
export type RoleGrantPrincipal =
  | { readonly type: "Role"; readonly roleId: string }
  | { readonly type: "User"; readonly userId: string }
  | { readonly type: "Group"; readonly groupId: string };

export interface RoleGrantProps {
  /** ID of the role granted. Changing it replaces the grant. */
  readonly role: string;
  /**
   * The role, user or group that receives `role`. Changing it replaces the
   * grant. A service account's roles belong to its `ServiceAccount`
   * (`role`, `additionalRoles`); grant to one here only when no
   * `ServiceAccount` resource manages it.
   */
  readonly principal: RoleGrantPrincipal;
  /**
   * Let the principal grant `role` on to others. Groups have no admin option.
   * @default false
   */
  readonly adminOption?: boolean;
}

export interface RoleGrantAttributes {
  /** ID of the granted role. */
  readonly roleId: string;
  /** Name of the granted role. */
  readonly roleName: string;
  /** Who holds the grant. */
  readonly principal: RoleGrantPrincipal;
  /** Whether the principal may grant the role on. */
  readonly adminOption: boolean;
}

export type RoleGrant = Resource<
  "StarburstGalaxy.Role.RoleGrant",
  RoleGrantProps,
  RoleGrantAttributes,
  never,
  Providers
>;

/** The principal a `RoleGrant` names does not exist. */
export class RoleGrantPrincipalNotFound extends Data.TaggedError(
  "StarburstGalaxy.RoleGrantPrincipalNotFound",
)<{ readonly principal: RoleGrantPrincipal }> {
  override get message() {
    return `Starburst Galaxy ${this.principal.type.toLowerCase()} ${principalId(this.principal)} does not exist`;
  }
}

/** The role a `RoleGrant` grants does not exist. */
export class RoleGrantRoleNotFound extends Data.TaggedError(
  "StarburstGalaxy.RoleGrantRoleNotFound",
)<{
  readonly roleId: string;
}> {
  override get message() {
    return `Starburst Galaxy role ${this.roleId} does not exist`;
  }
}

/**
 * One Starburst Galaxy role granted to one role, user or group: the
 * principal gets the role's privileges (Galaxy's `directlyGrantedRoles`).
 *
 * Galaxy stores a principal's grants as one list, so each `RoleGrant` reads
 * the list, adds or removes only its own role, and writes it back: grants
 * made in the console or by other stacks stay. Grants on the same
 * principal in one deploy take turns; Galaxy offers no conditional write,
 * so do not edit a principal's grants from two processes at once.
 * `adminOption` updates in place.
 *
 * @see https://docs.starburst.io/starburst-galaxy/security-and-compliance/manage-galaxy-access/manage-users-roles-and-tags/roles.html
 *
 * ### Granting a role to a role
 * **Example:** Analysts inherit everything the reporting role may do
 * ```typescript
 * const reporting = yield* StarburstGalaxy.Role.Role("Reporting", {});
 * const analysts = yield* StarburstGalaxy.Role.Role("Analysts", {});
 * yield* StarburstGalaxy.Role.RoleGrant("AnalystsReport", {
 *   role: reporting.roleId,
 *   principal: { type: "Role", roleId: analysts.roleId },
 * });
 * ```
 *
 * ### Granting a role to a person
 * **Example:** With the admin option, so they can grant it on
 * ```typescript
 * const lead = StarburstGalaxy.User.User.lookup({ email: "lead@example.com" });
 * const analysts = yield* StarburstGalaxy.Role.Role("Analysts", {});
 * yield* StarburstGalaxy.Role.RoleGrant("LeadAnalysts", {
 *   role: analysts.roleId,
 *   principal: { type: "User", userId: lead.userId },
 *   adminOption: true,
 * });
 * ```
 *
 * ### Granting a role to a group
 * **Example:** Every member of an identity-provider group
 * ```typescript
 * const finance = StarburstGalaxy.User.Group.lookup({ name: "finance" });
 * const ledger = yield* StarburstGalaxy.Role.Role("LedgerReaders", {});
 * yield* StarburstGalaxy.Role.RoleGrant("FinanceLedger", {
 *   role: ledger.roleId,
 *   principal: { type: "Group", groupId: finance.groupId },
 * });
 * ```
 *
 * @resource
 * @product Access
 */
export const RoleGrant = Resource<RoleGrant>("StarburstGalaxy.Role.RoleGrant");

interface DirectGrant {
  readonly roleId: string;
  readonly roleName: string;
  readonly adminOption: boolean;
}

const principalId = (principal: RoleGrantPrincipal) =>
  principal.type === "Role"
    ? principal.roleId
    : principal.type === "User"
      ? principal.userId
      : principal.groupId;

/** The principal's direct grants; `undefined` when the principal does not exist. */
const directGrants = (principal: RoleGrantPrincipal) =>
  Effect.gen(function* () {
    switch (principal.type) {
      case "Role": {
        const role = yield* galaxy.role
          .getRole({ roleId: principal.roleId })
          .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
        return role?.directlyGrantedRoles as ReadonlyArray<DirectGrant> | undefined;
      }
      case "User": {
        const user = yield* getUser(principal.userId);
        return user?.directlyGrantedRoles as ReadonlyArray<DirectGrant> | undefined;
      }
      case "Group": {
        const group = yield* findGroup(principal.groupId);
        return group?.roles.map((role) => ({ ...role, adminOption: false }));
      }
    }
  });

/**
 * Replace the principal's direct grants. Galaxy rebuilds each list item
 * from its role ID, name and admin option together, so all three are sent.
 */
const writeGrants = (principal: RoleGrantPrincipal, grants: ReadonlyArray<DirectGrant>) => {
  const list = grants.map(({ roleId, roleName, adminOption }) => ({
    roleId,
    roleName,
    adminOption,
  }));
  switch (principal.type) {
    case "Role":
      return galaxy.role
        .updateRole({ roleId: principal.roleId, directlyGrantedRoles: list })
        .pipe(Effect.asVoid);
    case "User":
      return galaxy.user
        .updateUser({ userId: principal.userId, directlyGrantedRoles: list })
        .pipe(Effect.asVoid);
    case "Group":
      return galaxy.group
        .updateGroup({
          groupId: principal.groupId,
          roles: list.map(({ roleId, roleName }) => ({ roleId, roleName })),
        })
        .pipe(Effect.asVoid);
  }
};

export const RoleGrantProvider = () => {
  // Grants on one principal read-modify-write one list: one at a time.
  const locks = new Map<string, Semaphore.Semaphore>();
  const exclusive = (principal: RoleGrantPrincipal) => {
    const key = `${principal.type}:${principalId(principal)}`;
    let lock = locks.get(key);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(key, lock);
    }
    return lock.withPermits(1);
  };

  const attributesOf = (
    principal: RoleGrantPrincipal,
    grant: DirectGrant,
  ): RoleGrantAttributes => ({
    roleId: grant.roleId,
    roleName: grant.roleName,
    principal,
    adminOption: grant.adminOption,
  });

  return Provider.succeed(RoleGrant, {
    stables: ["roleId", "roleName", "principal"],

    nuke: { dependsOn: ["StarburstGalaxy.Role.Role"] },

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      if (
        news.role !== olds.role ||
        news.principal.type !== olds.principal.type ||
        principalId(news.principal) !== principalId(olds.principal)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const principal = output?.principal ?? olds.principal;
      const roleId = output?.roleId ?? olds.role;
      const grants = yield* directGrants(principal);
      const grant = grants?.find((g) => g.roleId === roleId);
      if (grant === undefined) return undefined;
      const attributes = attributesOf(principal, grant);
      // A grant has no name to carry an ownership marker.
      return output !== undefined ? attributes : Unowned(attributes);
    }),

    reconcile: Effect.fn(function* ({ news, session }) {
      const adminOption = news.principal.type === "Group" ? false : (news.adminOption ?? false);
      return yield* Effect.gen(function* () {
        const grants = yield* directGrants(news.principal);
        if (grants === undefined) {
          return yield* new RoleGrantPrincipalNotFound({ principal: news.principal });
        }
        const existing = grants.find((g) => g.roleId === news.role);
        if (existing !== undefined && existing.adminOption === adminOption) {
          return attributesOf(news.principal, existing);
        }
        const role = yield* galaxy.role
          .getRole({ roleId: news.role })
          .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
        if (role === undefined) return yield* new RoleGrantRoleNotFound({ roleId: news.role });
        const grant: DirectGrant = { roleId: role.roleId, roleName: role.roleName, adminOption };
        yield* session.note(
          `Granting role ${role.roleName} to ${news.principal.type.toLowerCase()} ${principalId(news.principal)}...`,
        );
        yield* writeGrants(news.principal, [
          ...grants.filter((g) => g.roleId !== news.role),
          grant,
        ]);
        return attributesOf(news.principal, grant);
      }).pipe(exclusive(news.principal));
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* Effect.gen(function* () {
        const grants = yield* directGrants(output.principal);
        if (grants === undefined || !grants.some((g) => g.roleId === output.roleId)) return;
        yield* writeGrants(
          output.principal,
          grants.filter((g) => g.roleId !== output.roleId),
        );
      }).pipe(exclusive(output.principal));
    }),

    // Grants have no ownership marker; only state knows which are ours.
    list: () => Effect.succeed([]),
  });
};
