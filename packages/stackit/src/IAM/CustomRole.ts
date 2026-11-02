import * as authorization from "@distilled.cloud/stackit/authorization";
import { Unowned } from "alchemy/AdoptPolicy";
import { havePropsChanged, isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { StackitResourceFailed, waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  type AuthorizationResourceType,
  type AuthorizationScope,
  findCustomRole,
  resolveScope,
  sameScope,
} from "./internal/authorization.ts";

export type CustomRoleProps = {
  /**
   * Name of the role, unique on its resource. Members reference the role by
   * this name. 2–64 lowercase letters, optionally separated by single `-`
   * or `.` (no digits). If omitted, a unique name is generated from the
   * stack, stage and logical id. Renaming updates the role in place; it
   * keeps its id, but memberships that reference the old name must be
   * updated too.
   */
  name?: string;
  /**
   * Human-readable description, 1–255 characters.
   * @default the role name
   */
  description?: string;
  /**
   * Names of the predefined permissions the role grants, e.g.
   * `vpn.connection.get`. List the available permissions with the Membership
   * API's `GET /v2/permissions`. Updated in place.
   */
  permissions: string[];
  /**
   * Kind of resource the role is defined on. Changing it replaces the role.
   * @default "project"
   */
  resourceType?: AuthorizationResourceType;
  /**
   * Id of the project, folder or organization. Defaults to the profile's
   * project for `project` and to the profile's organization for
   * `organization`; required for `folder`. Changing it replaces the role.
   */
  resourceId?: string;
};

export type CustomRoleAttributes = {
  /** Id STACKIT assigned to the role. Stable across updates. */
  roleId: string;
  /** Name of the role; pass it as a {@link Membership}'s `role`. */
  name: string;
  /** Description of the role. */
  description: string;
  /** Permission names the role grants. */
  permissions: string[];
  /** Kind of resource the role is defined on. */
  resourceType: AuthorizationResourceType;
  /** Id of the project, folder or organization. */
  resourceId: string;
  /** Concurrency token of the last observed revision, if STACKIT returns one. */
  etag: string | undefined;
};

export type CustomRole = Resource<
  "Stackit.IAM.CustomRole",
  CustomRoleProps,
  CustomRoleAttributes,
  never,
  Providers
>;

/**
 * A custom role on a STACKIT project, folder or organization: a named set
 * of predefined permissions that {@link Membership} can grant like a
 * built-in role.
 *
 * Name, description and permissions update in place (the role keeps its
 * `roleId`, and updates are guarded by the observed `etag`); moving the
 * role to another resource replaces it. Deploy blocks until the role is
 * listed with the desired permissions.
 *
 * Ownership: custom roles carry no labels. Alchemy tracks a role by the
 * `roleId` it recorded; a role with the requested `name` that already
 * exists before the first deploy is reported as unowned and is only taken
 * over with `--adopt` (or `adopt(true)`). With no marker to filter by,
 * custom roles are not enumerated by `alchemy unsafe nuke`; they go away
 * with the resource they are defined on.
 *
 * See [STACKIT's custom role docs](https://docs.stackit.cloud/platform/access-and-identity/roles-permissions/custom-roles/).
 *
 * :::caution[Changing `resourceType` or `resourceId` replaces the Role]
 * A deploy creates a new role (with a new `roleId`) on the new resource before the old
 * one is deleted. Deleting a role that members still hold may be refused; memberships
 * that reference `role.name` are replaced or removed first.
 * :::
 *
 * ### Creating a custom role
 * **Example:** A project role with a generated name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const role = yield* Stackit.IAM.CustomRole("DnsReader", {
 *   permissions: ["vpn.connection.get"],
 * });
 * ```
 *
 * **Example:** A named role with a description
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * yield* Stackit.IAM.CustomRole("DnsOperator", {
 *   name: "dns-operator",
 *   description: "Reads zones and writes records",
 *   permissions: ["dns.zone.list", "dns.zone.create"],
 * });
 * ```
 *
 * ### Granting the role
 * **Example:** Bind the role to a service account
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const role = yield* Stackit.IAM.CustomRole("DnsOperator", {
 *   permissions: ["vpn.connection.get", "vpn.connection.status.get"],
 * });
 * yield* Stackit.IAM.Membership("CiDnsOperator", {
 *   subject: "ci-abc123@sa.stackit.cloud",
 *   role: role.name,
 * });
 * ```
 *
 * ### Roles on folders and organizations
 * **Example:** An organization-level role
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * yield* Stackit.IAM.CustomRole("OrgAuditor", {
 *   resourceType: "organization",
 *   permissions: ["resource-manager.project.read"],
 * });
 * ```
 *
 * @resource
 * @product STACKIT Authorization
 * @category IAM
 */
export const CustomRole = Resource<CustomRole>("Stackit.IAM.CustomRole");

/**
 * STACKIT role names are `^[a-z](?:[-.]?[a-z]){1,63}$`: letters only. Map
 * the generated physical name onto that alphabet (digits become letters,
 * runs of anything else one `-`).
 */
const toRoleName = (raw: string): string => {
  const letters = raw
    .toLowerCase()
    .replace(/[0-9]/g, (digit) => String.fromCharCode(97 + Number(digit)))
    .replace(/[^a-z]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const named = letters.length === 0 ? "role" : letters;
  return named.slice(0, 64).replace(/-+$/, "");
};

const roleNameOf = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, lowercase: true, maxLength: 64 }).pipe(Effect.map(toRoleName));

const permissionNames = (permissions: ReadonlyArray<{ readonly name: string }>) =>
  [...new Set(permissions.map((permission) => permission.name))].sort();

const desiredPermissions = (permissions: ReadonlyArray<string>) => [...new Set(permissions)].sort();

const samePermissions = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((name, i) => name === b[i]);

const toAttributes = (
  scope: AuthorizationScope,
  role: authorization.Role,
  roleId: string,
): CustomRoleAttributes => ({
  roleId,
  name: role.name,
  description: role.description,
  permissions: permissionNames(role.permissions),
  resourceType: scope.resourceType,
  resourceId: scope.resourceId,
  etag: role.etag,
});

export const CustomRoleProvider = () =>
  Provider.succeed(CustomRole, {
    stables: ["roleId", "resourceType", "resourceId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // Delete-first: role names are unique in a scope, and an unresolved scope
      // can resolve to the current one.
      if (hasUnresolvedTrigger<CustomRoleProps>(news, ["resourceType", "resourceId"])) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<CustomRoleProps>(news);
      const env = yield* StackitEnvironment.current;
      const scope = yield* resolveScope(resolved, env);
      if (!sameScope(scope, output)) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (!isResolved(news)) return undefined;
      // `name` is stable unless this update renames the role, so a membership
      // granting `role.name` isn't replaced when only the permissions change.
      if ((news.name === undefined || news.name === output.name) && havePropsChanged(olds, news)) {
        return {
          action: "update" as const,
          stables: ["roleId", "resourceType", "resourceId", "name"],
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output, previous }) {
      const env = yield* StackitEnvironment.current;
      const scope: AuthorizationScope =
        output !== undefined
          ? { resourceType: output.resourceType, resourceId: output.resourceId }
          : yield* resolveScope(olds ?? {}, env);
      // With state, track the recorded id. Without it, only an explicit
      // name can be looked up (a generated name is per-instance).
      const by: { roleId?: string; name?: string } =
        output !== undefined ? { roleId: output.roleId } : { name: olds?.name };
      if (by.roleId === undefined && by.name === undefined) return undefined;
      const role = yield* findCustomRole(scope, by);
      if (role?.id === undefined) return undefined;
      const attrs = toAttributes(scope, role, role.id);
      if (output !== undefined || previous?.roleId === attrs.roleId) return attrs;
      return Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* StackitEnvironment.current;
      const scope = yield* resolveScope(news, env);
      const name = yield* roleNameOf(id, news.name ?? output?.name);
      const description = news.description ?? name;
      const permissions = desiredPermissions(news.permissions);
      const request = {
        resourceType: scope.resourceType,
        resourceId: scope.resourceId,
        name,
        description,
        permissions: permissions.map((permission) => ({ name: permission })),
      };

      // Observe: the recorded id first; otherwise (first deploy, or a
      // crashed create that never recorded state) the name this instance
      // claims.
      let observed =
        output?.roleId !== undefined
          ? yield* findCustomRole(scope, { roleId: output.roleId })
          : undefined;
      if (observed === undefined) observed = yield* findCustomRole(scope, { name });

      // Ensure.
      let roleId: string | undefined = observed?.id;
      if (observed === undefined || observed.id === undefined) {
        const created = yield* authorization.addRole(request);
        roleId = created.role.id;
      } else if (
        // Sync: name, description and permissions against observed state.
        observed.name !== name ||
        observed.description !== description ||
        !samePermissions(permissionNames(observed.permissions), permissions)
      ) {
        yield* authorization.updateRole({
          ...request,
          roleId: observed.id,
          etag: observed.etag,
        });
      }

      // Role writes are eventually consistent: block until the list shows
      // the role with the desired shape, and return that observation.
      const settled = yield* waitFor({
        resource: `STACKIT custom role ${name} on ${scope.resourceType} ${scope.resourceId}`,
        read: findCustomRole(scope, roleId !== undefined ? { roleId } : { name }),
        ready: (role) =>
          role?.id !== undefined &&
          role.name === name &&
          role.description === description &&
          samePermissions(permissionNames(role.permissions), permissions),
        state: (role) => (role === undefined ? "absent" : "pending"),
        timeout: "1 minute",
      });
      if (settled?.id === undefined) {
        // Unreachable: `ready` only accepts a listed role with an id.
        return yield* new StackitResourceFailed({
          resource: `STACKIT custom role ${name}`,
          state: undefined,
          message: `STACKIT custom role ${name} is not listed after create`,
        });
      }
      return toAttributes(scope, settled, settled.id);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope: AuthorizationScope = {
        resourceType: output.resourceType,
        resourceId: output.resourceId,
      };
      const observe = findCustomRole(scope, { roleId: output.roleId });
      const observed = yield* observe;
      if (observed === undefined) return;
      yield* authorization.deleteRole({
        resourceType: scope.resourceType,
        resourceId: scope.resourceId,
        roleId: output.roleId,
        etag: observed.etag,
      });
      yield* waitUntilGone({
        resource: `STACKIT custom role ${output.name} on ${scope.resourceType} ${scope.resourceId}`,
        read: observe,
        state: (role) => role.name,
        timeout: "1 minute",
      });
    }),
  });
