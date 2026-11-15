import * as roles from "@distilled.cloud/clickhouse-cloud/role_management";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { SystemRoleImmutable } from "../Errors.ts";
import { isGeneratedName, isOwnedName, resolveName } from "../internal/Names.ts";
import type { Providers } from "../Providers.ts";

/** One rule of a role: allow or deny permissions on resources. */
export interface RolePolicy {
  /** Whether the policy grants or denies. */
  allowDeny: "ALLOW" | "DENY";
  /**
   * Permissions, e.g. `control-plane:service:view`,
   * `control-plane:service:manage`, `control-plane:organization:view`.
   */
  permissions: string[];
  /**
   * Resources the policy applies to: `instance/<serviceId>`,
   * `instance/*`, or `organization/<organizationId>`.
   */
  resources: string[];
  /** SQL console options: database grants and the console role. */
  tags?: {
    /** Databases the policy grants in the SQL console. */
    grants?: string[];
    /** SQL console role. */
    roleV2?: "sql-console-readonly" | "sql-console-admin";
  };
}

export interface RoleProps {
  /**
   * Role name. If omitted, a unique name is generated from the stack, stage
   * and logical ID. Changing it renames the role in place.
   */
  name?: string;
  /**
   * The role's policies. Alchemy converges the role to these. ClickHouse
   * adds the permissions a declared one implies
   * (`control-plane:organization:view` also grants
   * `control-plane:organization:view-udfs`); the `policies` attribute shows
   * them.
   */
  policies: RolePolicy[];
  /**
   * Who acts with the role: `user/<userId>` or `apiKey/<keyId>`. Alchemy
   * converges the role to exactly these. Omit to leave membership to the
   * other side (a key's `assignedRoleIds`). A key can't be created without
   * a role, so give it its first role through `assignedRoleIds`; a role
   * that lists the key in `actors` adds to it.
   */
  actors?: string[];
}

export interface RoleAttributes {
  /** Role ID. */
  roleId: string;
  /** Organization that owns the role. */
  organizationId: string;
  /** Role name. */
  name: string;
  /** `custom` for roles alchemy manages. */
  type: string | undefined;
  /** Actors that act with the role. */
  actors: string[];
  /** The role's policies, as ClickHouse stores them. */
  policies: RolePolicy[];
  /** When the role was created. */
  createdAt: string | undefined;
  /** When the role was last updated. */
  updatedAt: string | undefined;
}

export type Role = Resource<
  "ClickHouseCloud.RoleManagement.Role",
  RoleProps,
  RoleAttributes,
  never,
  Providers
>;

/**
 * A custom ClickHouse Cloud role: a set of policies that allow or deny
 * Cloud API permissions on services or the organization, and the users and
 * API keys that act with it.
 *
 * Roles are how API keys get least privilege: a key with one role that
 * allows `control-plane:service:view` on `instance/<serviceId>` can read
 * that one service and nothing else. The bindings (`GetService`,
 * `ListBackups`, …) create one such role and one key holding it per
 * binding and host.
 *
 * Predefined system roles are never created, changed, or deleted. Roles
 * have no tags, so a generated name is the ownership marker: `alchemy
 * unsafe nuke` only deletes custom roles whose name has the shape alchemy
 * generates.
 * @see https://clickhouse.com/docs/cloud/security/console-roles
 *
 * ### Creating a Role
 * **Example:** Read one service
 * ```typescript
 * const analytics = yield* ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 * });
 * const viewer = yield* ClickHouseCloud.RoleManagement.Role("AnalyticsViewer", {
 *   policies: [
 *     {
 *       allowDeny: "ALLOW",
 *       permissions: ["control-plane:service:view"],
 *       resources: [Output.interpolate`instance/${analytics.serviceId}`],
 *     },
 *   ],
 * });
 * ```
 *
 * ### Assigning Actors
 * **Example:** Add a second role to an existing key
 * ```typescript
 * const base = yield* ClickHouseCloud.RoleManagement.Role("Base", {
 *   policies: [
 *     {
 *       allowDeny: "ALLOW",
 *       permissions: ["control-plane:organization:view"],
 *       resources: ["organization/<organization id>"],
 *     },
 *   ],
 * });
 * // A key is created with its first role.
 * const key = yield* ClickHouseCloud.ApiKeys.ApiKey("Dashboards", {
 *   assignedRoleIds: [base.roleId],
 * });
 * const viewer = yield* ClickHouseCloud.RoleManagement.Role("Viewer", {
 *   policies: [
 *     {
 *       allowDeny: "ALLOW",
 *       permissions: ["control-plane:service:view"],
 *       resources: ["instance/*"],
 *     },
 *   ],
 *   actors: [Output.interpolate`apiKey/${key.id}`],
 * });
 * ```
 *
 * @resource
 * @product Role
 */
export const Role = Resource<Role>("ClickHouseCloud.RoleManagement.Role");

const toPolicies = (policies: roles.RBACPolicy[] | undefined): RolePolicy[] =>
  (policies ?? []).map((p) => ({
    allowDeny: p.allowDeny ?? "ALLOW",
    permissions: p.permissions ?? [],
    resources: p.resources ?? [],
    ...(p.tags?.grants !== undefined || p.tags?.roleV2 !== undefined
      ? {
          tags: {
            ...(p.tags.grants !== undefined ? { grants: p.tags.grants } : {}),
            ...(p.tags.roleV2 !== undefined
              ? { roleV2: p.tags.roleV2 as "sql-console-readonly" | "sql-console-admin" }
              : {}),
          },
        }
      : {}),
  }));

/** A policy as a comparable string, ignoring server fields and list order. */
const policyKey = (p: RolePolicy) =>
  JSON.stringify([
    p.allowDeny,
    [...p.permissions].sort(),
    [...p.resources].sort(),
    [...(p.tags?.grants ?? [])].sort(),
    p.tags?.roleV2 ?? null,
  ]);

const samePolicies = (a: RolePolicy[], b: RolePolicy[]) =>
  deepEqual(a.map(policyKey).sort(), b.map(policyKey).sort());

/**
 * Whether the observed policies still grant everything `desired` declares.
 * ClickHouse stores each policy with the permissions a declared one implies
 * (`control-plane:organization:view` comes back with
 * `control-plane:organization:view-udfs`), so an observed policy covers a
 * desired one when it has the same effect, resources and tags and at least
 * its permissions.
 */
const coversPolicies = (observed: RolePolicy[], desired: RolePolicy[]) =>
  desired.every((want) =>
    observed.some(
      (have) =>
        have.allowDeny === want.allowDeny &&
        deepEqual([...have.resources].sort(), [...want.resources].sort()) &&
        deepEqual([...(have.tags?.grants ?? [])].sort(), [...(want.tags?.grants ?? [])].sort()) &&
        (have.tags?.roleV2 ?? null) === (want.tags?.roleV2 ?? null) &&
        want.permissions.every((permission) => have.permissions.includes(permission)),
    ),
  );

const toAttributes = (organizationId: string, role: roles.RBACRole): RoleAttributes => ({
  roleId: role.id ?? "",
  organizationId,
  name: role.name ?? "",
  type: role.type,
  actors: role.actors ?? [],
  policies: toPolicies(role.policies),
  createdAt: role.createdAt,
  updatedAt: role.updatedAt,
});

export const RoleProvider = () =>
  Provider.effect(
    Role,
    Effect.gen(function* () {
      const listRoles = (organizationId: string) => roles.listOrganizationRoles({ organizationId });
      const getRole = (organizationId: string, roleId: string) =>
        roles
          .getOrganizationRole({ organizationId, roleId })
          .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      const findByName = (organizationId: string, name: string) =>
        Effect.map(listRoles(organizationId), (all) =>
          all.find((r) => r.name === name && r.type === "custom"),
        );

      return {
        stables: ["roleId", "organizationId", "createdAt"],
        list: Effect.fn(function* () {
          const organizationId = yield* currentOrganizationId;
          const all = yield* listRoles(organizationId);
          return all
            .filter(
              (r) => r.type === "custom" && r.id !== undefined && isGeneratedName(r.name ?? ""),
            )
            .map((r) => toAttributes(organizationId, r));
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
          const name = yield* resolveName(id, olds?.name, output?.name);
          const observed = output?.roleId
            ? yield* getRole(organizationId, output.roleId)
            : yield* findByName(organizationId, name);
          if (observed === undefined) return undefined;
          const attrs = toAttributes(organizationId, observed);
          if (observed.type === "system") return Unowned(attrs);
          return (yield* isOwnedName(
            id,
            attrs.name,
            output !== undefined || attrs.roleId === previous?.roleId,
          ))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, output }) {
          const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
          const name = yield* resolveName(id, news.name, output?.name);

          // Observe
          let observed = output?.roleId
            ? yield* getRole(organizationId, output.roleId)
            : yield* findByName(organizationId, name);
          if (observed?.type === "system") {
            return yield* new SystemRoleImmutable({ roleId: observed.id ?? "", roleName: name });
          }

          // Ensure
          const created = observed === undefined;
          if (observed === undefined) {
            observed = yield* roles.createOrganizationRole({
              organizationId,
              name,
              actors: news.actors ?? [],
              policies: news.policies,
            });
          }

          // Sync only what differs. Observed policies carry the permissions
          // ClickHouse adds to the declared ones, so they are the baseline only
          // for whether every declared grant is still there; whether a grant
          // was dropped from the props comes from the last applied props. An
          // adopted role (no props yet) gets the declared policies once.
          const policiesChanged =
            !coversPolicies(toPolicies(observed.policies), news.policies) ||
            (olds === undefined ? !created : !samePolicies(news.policies, olds.policies));
          const patch: Omit<roles.UpdateOrganizationRoleRequest, "organizationId" | "roleId"> = {
            ...(observed.name !== name ? { name } : {}),
            ...(policiesChanged ? { policies: news.policies } : {}),
            ...(news.actors !== undefined &&
            !deepEqual([...news.actors].sort(), [...(observed.actors ?? [])].sort())
              ? { actors: news.actors }
              : {}),
          };
          if (Object.keys(patch).length > 0) {
            observed = yield* roles.updateOrganizationRole({
              organizationId,
              roleId: observed.id!,
              ...patch,
            });
          }
          return toAttributes(organizationId, observed);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (output.type === "system") return;
          // Live: deleting a role that still holds a `sql-console:` policy
          // answers 500 `Internal error`; dropping those policies first lets
          // the delete through.
          const sqlConsole = (p: RolePolicy) =>
            p.permissions.some((permission) => permission.startsWith("sql-console:"));
          if (output.policies.some(sqlConsole)) {
            yield* roles
              .updateOrganizationRole({
                organizationId: output.organizationId,
                roleId: output.roleId,
                policies: output.policies.filter((p) => !sqlConsole(p)),
              })
              .pipe(Effect.catchTag("NotFound", () => Effect.void));
          }
          yield* roles
            .deleteOrganizationRole({
              organizationId: output.organizationId,
              roleId: output.roleId,
            })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      };
    }),
  );
