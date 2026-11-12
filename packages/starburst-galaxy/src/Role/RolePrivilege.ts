import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type {
  GrantedPrivilege,
  GrantRolePrivilegeRequestEntityKind,
  GrantRolePrivilegeRequestPrivilege,
} from "@distilled.cloud/starburst-galaxy/privilege";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { BUILT_IN_ROLES, findFirst } from "../internal.ts";
import type { Providers } from "../Providers.ts";

/**
 * The object a privilege applies to. Schema, table and column privileges
 * name their object inside a catalog; `"*"` matches every schema, table or
 * column.
 */
export type RolePrivilegeEntity =
  | { readonly kind: "Cluster"; readonly clusterId: string }
  | { readonly kind: "Catalog"; readonly catalogId: string }
  | { readonly kind: "Schema"; readonly catalogId: string; readonly schemaName: string }
  | {
      readonly kind: "Table";
      readonly catalogId: string;
      readonly schemaName: string;
      readonly tableName: string;
    }
  | {
      readonly kind: "Column";
      readonly catalogId: string;
      readonly schemaName: string;
      readonly tableName: string;
      readonly columnName: string;
    }
  | {
      readonly kind: Exclude<
        GrantRolePrivilegeRequestEntityKind,
        "Cluster" | "Catalog" | "Schema" | "Table" | "Column"
      >;
      /** Galaxy's ID of the object (the account ID for `"Account"`). */
      readonly entityId: string;
    };

export interface RolePrivilegeProps {
  /** ID of the role the privilege is granted to (a `Role`'s `roleId`). Changing it replaces the grant. */
  readonly role: string;
  /** The privilege, e.g. `"UseCluster"`, `"Select"`, `"CreateTable"`. Changing it replaces the grant. */
  readonly privilege: GrantRolePrivilegeRequestPrivilege;
  /** The object the privilege applies to. Changing it replaces the grant. */
  readonly entity: RolePrivilegeEntity;
  /**
   * `"Allow"` grants the privilege; `"Deny"` refuses it even when another
   * role allows it. Changing it replaces the grant.
   * @default "Allow"
   */
  readonly grantKind?: "Allow" | "Deny";
  /**
   * Let the role grant this privilege to other roles. Changing it replaces the grant.
   * @default false
   */
  readonly grantOption?: boolean;
}

export interface RolePrivilegeAttributes {
  /** ID of the role holding the privilege. */
  readonly roleId: string;
  /** The privilege. */
  readonly privilege: string;
  /** Galaxy's entity kind. */
  readonly entityKind: string;
  /** Galaxy's entity ID (the catalog ID for schema, table and column privileges). */
  readonly entityId: string;
  /** Schema name, for schema, table and column privileges. */
  readonly schemaName: string | undefined;
  /** Table name, for table and column privileges. */
  readonly tableName: string | undefined;
  /** Column name, for column privileges. */
  readonly columnName: string | undefined;
  /** `"Allow"` or `"Deny"`. */
  readonly grantKind: string;
  /** Whether the role may grant the privilege on. */
  readonly grantOption: boolean;
}

export type RolePrivilege = Resource<
  "StarburstGalaxy.RolePrivilege",
  RolePrivilegeProps,
  RolePrivilegeAttributes,
  never,
  Providers
>;

/**
 * One privilege granted to one Starburst Galaxy role: using a cluster,
 * creating catalogs, selecting from tables, and so on. Each grant is its
 * own resource, so privileges granted in Galaxy or by other stacks are
 * never revoked by a deploy.
 *
 * Every prop is part of the grant's identity: changing any of them revokes
 * the old grant and grants the new one. Galaxy lists privileges up to about
 * five seconds stale, so a deploy re-reads a new grant for up to 15 seconds
 * before returning.
 *
 * @see https://docs.starburst.io/starburst-galaxy/security/privileges.html
 *
 * ### Granting cluster access
 * **Example:** Let a role run queries on a cluster
 * ```typescript
 * const cluster = yield* StarburstGalaxy.Cluster("Analytics", { cloudRegionId: "aws-us-east1" });
 * const analysts = yield* StarburstGalaxy.Role("Analysts", {});
 * yield* StarburstGalaxy.RolePrivilege("AnalystsUseCluster", {
 *   role: analysts.roleId,
 *   privilege: "UseCluster",
 *   entity: { kind: "Cluster", clusterId: cluster.clusterId },
 * });
 * ```
 *
 * ### Granting data access
 * **Example:** Read every table of one schema
 * ```typescript
 * const catalog = StarburstGalaxy.PostgresqlCatalog.lookup({ name: "analytics" });
 * const analysts = yield* StarburstGalaxy.Role("Analysts", {});
 * yield* StarburstGalaxy.RolePrivilege("AnalystsSelectSales", {
 *   role: analysts.roleId,
 *   privilege: "Select",
 *   entity: { kind: "Table", catalogId: catalog.catalogId, schemaName: "sales", tableName: "*" },
 * });
 * ```
 *
 * **Example:** Deny one sensitive column
 * ```typescript
 * const catalog = StarburstGalaxy.PostgresqlCatalog.lookup({ name: "analytics" });
 * const analysts = yield* StarburstGalaxy.Role("Analysts", {});
 * yield* StarburstGalaxy.RolePrivilege("AnalystsNoSsn", {
 *   role: analysts.roleId,
 *   privilege: "Select",
 *   grantKind: "Deny",
 *   entity: {
 *     kind: "Column",
 *     catalogId: catalog.catalogId,
 *     schemaName: "hr",
 *     tableName: "employees",
 *     columnName: "ssn",
 *   },
 * });
 * ```
 *
 * ### Granting account privileges
 * **Example:** Let a role create catalogs
 * ```typescript
 * const engineers = yield* StarburstGalaxy.Role("Engineers", {});
 * yield* StarburstGalaxy.RolePrivilege("EngineersCreateCatalog", {
 *   role: engineers.roleId,
 *   privilege: "CreateCatalog",
 *   entity: { kind: "Account", entityId: "a-1234567890" },
 * });
 * ```
 *
 * @resource
 * @product Access control
 */
export const RolePrivilege = Resource<RolePrivilege>("StarburstGalaxy.RolePrivilege");

/** The grant tuple as Galaxy names it. */
const tupleOf = (props: RolePrivilegeProps): RolePrivilegeAttributes => {
  const entity = props.entity;
  const scope =
    entity.kind === "Cluster"
      ? { entityId: entity.clusterId }
      : entity.kind === "Catalog"
        ? { entityId: entity.catalogId }
        : entity.kind === "Schema"
          ? { entityId: entity.catalogId, schemaName: entity.schemaName }
          : entity.kind === "Table"
            ? {
                entityId: entity.catalogId,
                schemaName: entity.schemaName,
                tableName: entity.tableName,
              }
            : entity.kind === "Column"
              ? {
                  entityId: entity.catalogId,
                  schemaName: entity.schemaName,
                  tableName: entity.tableName,
                  columnName: entity.columnName,
                }
              : { entityId: entity.entityId };
  return {
    roleId: props.role,
    privilege: props.privilege,
    entityKind: entity.kind,
    schemaName: undefined,
    tableName: undefined,
    columnName: undefined,
    ...scope,
    grantKind: props.grantKind ?? "Allow",
    grantOption: props.grantOption ?? false,
  };
};

const toAttributes = (roleId: string, granted: GrantedPrivilege): RolePrivilegeAttributes => ({
  roleId,
  privilege: granted.privilege,
  entityKind: granted.entityKind,
  entityId: granted.entityId,
  schemaName: granted.schemaName,
  tableName: granted.tableName,
  columnName: granted.columnName,
  grantKind: granted.grantKind,
  grantOption: granted.grantOption,
});

/** Whether `granted` is the privilege `tuple` describes, whatever its grant option. */
const sameGrant = (granted: GrantedPrivilege, tuple: RolePrivilegeAttributes) =>
  granted.privilege === tuple.privilege &&
  granted.entityKind === tuple.entityKind &&
  granted.entityId === tuple.entityId &&
  granted.schemaName === tuple.schemaName &&
  granted.tableName === tuple.tableName &&
  granted.columnName === tuple.columnName &&
  granted.grantKind === tuple.grantKind;

/** The role's direct grant of `tuple`; `undefined` when absent or the role is gone. */
const observe = (tuple: RolePrivilegeAttributes) =>
  findFirst(
    galaxy.privilege.listRolePrivileges.items({ roleId: tuple.roleId, listAllPrivileges: false }),
    (granted) => sameGrant(granted, tuple),
  ).pipe(
    Effect.map((granted) => granted && toAttributes(tuple.roleId, granted)),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const RolePrivilegeProvider = () =>
  Provider.succeed(RolePrivilege, {
    stables: [
      "roleId",
      "privilege",
      "entityKind",
      "entityId",
      "schemaName",
      "tableName",
      "columnName",
      "grantKind",
      "grantOption",
    ],

    nuke: {
      // Revoke privileges before the roles, clusters and catalogs they name.
      dependsOn: ["StarburstGalaxy.Role", "StarburstGalaxy.Cluster", "StarburstGalaxy.*Catalog"],
    },

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      const before = tupleOf(olds);
      const after = tupleOf(news);
      if (deepEqual(before, after)) return undefined;
      // Galaxy revokes by privilege and object, whatever the grant kind and
      // option: when only those change, revoking after granting would remove
      // the new grant too.
      const sameObject = deepEqual(
        { ...before, grantKind: undefined, grantOption: undefined },
        { ...after, grantKind: undefined, grantOption: undefined },
      );
      return { action: "replace", deleteFirst: sameObject } as const;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const tuple = output ?? tupleOf(olds);
      const granted = yield* observe(tuple);
      if (granted === undefined) return undefined;
      // A grant has no name to carry an ownership marker: one found without
      // prior state may have been made by someone else.
      return output !== undefined ? granted : Unowned(granted);
    }),

    reconcile: Effect.fn(function* ({ news, session }) {
      const tuple = tupleOf(news);

      // Observe: the exact grant, its grant option included.
      const observed = yield* observe(tuple);
      if (observed !== undefined && observed.grantOption === tuple.grantOption) return observed;

      // Ensure: granting an existing tuple again sets its grant option.
      yield* session.note(
        `Granting ${tuple.privilege} on ${tuple.entityKind} to ${tuple.roleId}...`,
      );
      yield* galaxy.privilege
        .grantRolePrivilege({
          roleId: tuple.roleId,
          privilege: tuple.privilege,
          entityKind: tuple.entityKind,
          entityId: tuple.entityId,
          schemaName: tuple.schemaName,
          tableName: tuple.tableName,
          columnName: tuple.columnName,
          grantKind: tuple.grantKind,
          grantOption: tuple.grantOption,
        })
        .pipe(Effect.catchTag("Conflict", () => Effect.void));

      // Galaxy lists privileges up to ~5 s stale: read the grant back, bounded at 15 s.
      const visible = yield* observe(tuple).pipe(
        Effect.repeat({
          until: (granted) => granted?.grantOption === tuple.grantOption,
          schedule: Schedule.spaced("2 seconds"),
          times: 7,
        }),
      );
      if (visible === undefined || visible.grantOption !== tuple.grantOption) {
        yield* session.note(
          `Galaxy has not listed the ${tuple.privilege} grant yet; it was accepted and will appear shortly.`,
        );
        return tuple;
      }
      return visible;
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* galaxy.privilege
        .revokeRolePrivilege({
          roleId: output.roleId,
          privilege: output.privilege,
          entityKind: output.entityKind,
          entityId: output.entityId,
          schemaName: output.schemaName,
          tableName: output.tableName,
          columnName: output.columnName,
          revokeAction: "RemoveRoleGrant",
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    // Every direct grant of every role but Galaxy's built-in ones.
    list: () =>
      galaxy.role.listRoles.items({}).pipe(
        Stream.filter((role) => !BUILT_IN_ROLES[role.roleName]),
        Stream.flatMap((role) =>
          galaxy.privilege.listRolePrivileges
            .items({ roleId: role.roleId, listAllPrivileges: false })
            .pipe(Stream.map((granted) => toAttributes(role.roleId, granted))),
        ),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      ),
  });
