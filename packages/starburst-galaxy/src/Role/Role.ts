import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type { Role as RoleShape } from "@distilled.cloud/starburst-galaxy/role";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  BUILT_IN_ROLES,
  changedFields,
  collectAll,
  findFirst,
  hasChanges,
  ownership,
  physicalName,
  ROLE_NAME,
} from "../internal.ts";
import type { Providers } from "../Providers.ts";

export interface RoleProps {
  /**
   * Role name, as SQL's `SET ROLE` and Galaxy's role list show it.
   * Renaming updates the role in place.
   * @default generated from the stack, logical id and stage (lowercase, `_`-delimited)
   */
  readonly name?: string;
  /**
   * Description shown in Galaxy.
   * @default ""
   */
  readonly description?: string;
  /**
   * ID of the role that owns this one and may manage it. Galaxy makes the
   * creating role the owner; transferring ownership to a role the deploying
   * client does not hold can leave the role unmanageable by Alchemy.
   * @default the deploying client's role
   */
  readonly owningRole?: string;
  /**
   * Grant the new role to the deploying client's role, so the deployer can
   * use and manage it. Applies when the role is created; changing it later
   * has no effect.
   * @default true
   */
  readonly grantToCreatingRole?: boolean;
}

export interface RoleAttributes {
  /** Galaxy's role ID (`r-…`). */
  readonly roleId: string;
  /** Role name. */
  readonly name: string;
  /** Description shown in Galaxy. */
  readonly description: string | undefined;
  /** ID of the owning role. */
  readonly owningRoleId: string | undefined;
  /** Creation time. */
  readonly createdOn: string;
  /** Last modification time. */
  readonly modifiedOn: string;
}

/** Find a role this stack doesn't manage, such as `accountadmin` or `public`, by its name. */
export interface RoleLookup {
  /** Role name. */
  readonly name: string;
}

export type Role = Resource<
  "StarburstGalaxy.Role",
  RoleProps,
  RoleAttributes,
  never,
  Providers,
  RoleLookup
>;

/**
 * A Starburst Galaxy role. Privileges are granted to roles
 * (`StarburstGalaxy.RolePrivilege`), roles are the default and additional
 * roles of service accounts, and policies and data domains are owned by
 * roles.
 *
 * The role's own name, description and owner are managed here; grants of
 * other roles to it are not, so grants made in Galaxy or by other stacks
 * survive a deploy. Galaxy roles have no labels or tags: a role Alchemy
 * created is recognized by its generated name.
 *
 * @see https://docs.starburst.io/starburst-galaxy/security/roles.html
 *
 * ### Creating a role
 * **Example:** A role for analysts
 * ```typescript
 * const analysts = yield* StarburstGalaxy.Role("Analysts", {
 *   description: "Read access to the analytics catalogs",
 * });
 * ```
 *
 * **Example:** A role owned by another role
 * ```typescript
 * const admins = yield* StarburstGalaxy.Role("DataAdmins", {});
 * yield* StarburstGalaxy.Role("Analysts", { owningRole: admins.roleId });
 * ```
 *
 * ### Granting privileges to the role
 * **Example:** Let the role query a catalog
 * ```typescript
 * const catalog = StarburstGalaxy.PostgresqlCatalog.lookup({ name: "analytics" });
 * const analysts = yield* StarburstGalaxy.Role("Analysts", {});
 * yield* StarburstGalaxy.RolePrivilege("AnalystsSelect", {
 *   role: analysts.roleId,
 *   privilege: "Select",
 *   entity: { kind: "Table", catalogId: catalog.catalogId, schemaName: "*", tableName: "*" },
 * });
 * ```
 *
 * ### Looking up a built-in role
 * **Example:** Reference `accountadmin`
 * ```typescript
 * const admin = StarburstGalaxy.Role.lookup({ name: "accountadmin" });
 * ```
 *
 * @resource
 * @product Access control
 */
export const Role = Resource<Role>("StarburstGalaxy.Role");

/** Galaxy accepted a role create but the role could not be read back. */
export class RoleNotResolved extends Data.TaggedError("StarburstGalaxy.RoleNotResolved")<{
  readonly roleName: string;
}> {
  override get message() {
    return `Role ${this.roleName} could not be found after it was created`;
  }
}

const toAttributes = (role: RoleShape): RoleAttributes => ({
  roleId: role.roleId,
  name: role.roleName,
  description: role.roleDescription,
  owningRoleId: role.owningRoleId,
  createdOn: role.createdOn,
  modifiedOn: role.modifiedOn,
});

const getRole = (roleId: string) =>
  galaxy.role.getRole({ roleId }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const findByName = (name: string) =>
  findFirst(galaxy.role.listRoles.items({}), (role) => role.roleName === name);

const observe = Effect.fn(function* (roleId: string | undefined, name: string) {
  if (roleId !== undefined) {
    const byId = yield* getRole(roleId);
    if (byId !== undefined) return byId;
  }
  return yield* findByName(name);
});

export const RoleProvider = () =>
  Provider.succeed(Role, {
    stables: ["roleId", "createdOn"],

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const name = output?.name ?? (yield* physicalName(id, olds?.name, ROLE_NAME));
      const role = yield* observe(output?.roleId, name);
      if (role === undefined) return undefined;
      return ownership(toAttributes(role), {
        output,
        explicitName: olds?.name,
        previous,
        key: "roleId",
      });
    }),

    lookup: Effect.fn(function* ({ name }) {
      const role = yield* findByName(name);
      return role === undefined ? undefined : toAttributes(role);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const name = yield* physicalName(id, news.name, ROLE_NAME);

      // Observe
      let role = yield* observe(output?.roleId, name);

      // Ensure: `owningRoleId` is not a create field; the sync below sets it.
      if (role === undefined) {
        yield* session.note(`Creating role ${name}...`);
        const created = yield* galaxy.role
          .createRole({
            roleName: name,
            roleDescription: news.description,
            grantToCreatingRole: news.grantToCreatingRole ?? true,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        role = created ?? (yield* findByName(name));
      }
      if (role === undefined) {
        return yield* new RoleNotResolved({ roleName: name });
      }

      // Sync: name, description and owner; never `directlyGrantedRoles`.
      const delta = changedFields(
        { ...role, roleDescription: role.roleDescription ?? "" },
        {
          roleName: name,
          roleDescription: news.description ?? "",
          owningRoleId: news.owningRole,
        },
      );
      if (hasChanges(delta)) {
        yield* session.note(`Updating role ${name}...`);
        role = yield* galaxy.role.updateRole({ ...delta, roleId: role.roleId });
      }

      return toAttributes(role);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* galaxy.role
        .deleteRole({ roleId: output.roleId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    // Galaxy's built-in roles exist in every account and cannot be deleted.
    list: () =>
      galaxy.role.listRoles.items({}).pipe(
        Stream.filter((role) => !BUILT_IN_ROLES[role.roleName]),
        (roles) => collectAll(roles, toAttributes),
      ),
  });
