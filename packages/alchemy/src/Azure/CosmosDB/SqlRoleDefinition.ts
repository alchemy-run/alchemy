import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  accountIdOf,
  canonical,
  deterministicGuid,
  expandScope,
  waitForChild,
  whileAccountBusy,
} from "./Shared.ts";

export interface SqlRolePermission {
  /**
   * Data actions the role allows, e.g.
   * `Microsoft.DocumentDB/databaseAccounts/readMetadata` or
   * `Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/read`.
   * Wildcards (`.../items/*`) are allowed.
   */
  dataActions: string[];
  /** Data actions excluded from `dataActions`. */
  notDataActions?: string[];
}

export interface SqlRoleDefinitionProps {
  /** Resource group of the account. Changing it replaces the role. */
  resourceGroup: string;
  /** Name of the Cosmos DB account. Changing it replaces the role. */
  account: string;
  /**
   * Display name of the role, unique within the account. If omitted, a
   * unique name is generated from the app, stage, and logical ID.
   */
  roleName?: string;
  /** Data-plane permissions granted by the role. */
  permissions: SqlRolePermission[];
  /**
   * Scopes the role may be assigned at, relative to the account (`/`,
   * `/dbs/{db}`, `/dbs/{db}/colls/{container}`) or as full ARM IDs.
   * @default ["/"] (the whole account)
   */
  assignableScopes?: string[];
}

export interface SqlRoleDefinition extends Resource<
  "Azure.CosmosDB.SqlRoleDefinition",
  SqlRoleDefinitionProps,
  {
    /** Role definition GUID. */
    roleDefinitionName: string;
    /** Full ARM ID of the role definition; pass it to `SqlRoleAssignment`. */
    roleDefinitionId: string;
    /** Display name of the role. */
    roleName: string;
    /** Name of the Cosmos DB account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Full ARM IDs of the assignable scopes. */
    assignableScopes: string[];
  },
  never,
  Providers
> {}

/**
 * A custom data-plane role for an Azure Cosmos DB for NoSQL account. Assign
 * it with {@link SqlRoleAssignment}. For common cases use the built-in roles
 * in {@link SqlBuiltInRole} instead of creating one.
 *
 * Cosmos DB role definitions cannot be tagged; the role's GUID is derived
 * from the stack, stage, logical ID, and instance ID, which marks it as
 * owned by Alchemy.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/nosql/security/how-to-grant-data-plane-role-based-access
 *
 * ### Creating a Role
 * **Example:** Read-only role over items
 * ```typescript
 * const reader = yield* Azure.CosmosDB.SqlRoleDefinition("item-reader", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   permissions: [
 *     {
 *       dataActions: [
 *         "Microsoft.DocumentDB/databaseAccounts/readMetadata",
 *         "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/read",
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Role assignable only on one database
 * ```typescript
 * const writer = yield* Azure.CosmosDB.SqlRoleDefinition("orders-writer", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   assignableScopes: ["/dbs/orders"],
 *   permissions: [
 *     {
 *       dataActions: [
 *         "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/*",
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const SqlRoleDefinition = Resource<SqlRoleDefinition>(
  "Azure.CosmosDB.SqlRoleDefinition",
);

const normalizeScopes = (scopes: readonly string[]) =>
  scopes
    .map((s) => s.replace(/\/+$/, "").toLowerCase())
    .sort()
    .join(",");

const createRoleName = (id: string) =>
  createPhysicalName({ id, maxLength: 128 });

const getRoleDefinition = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  roleDefinitionId: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetSqlResourceSqlRoleDefinition({
      subscriptionId,
      resourceGroupName,
      accountName,
      roleDefinitionId,
    }),
  );

const toPermissions = (permissions: readonly SqlRolePermission[]) =>
  permissions.map((p) => ({
    dataActions: [...p.dataActions],
    notDataActions: p.notDataActions ? [...p.notDataActions] : undefined,
  }));

const permissionsKey = (
  permissions: ReadonlyArray<{
    dataActions?: readonly string[];
    notDataActions?: readonly string[];
  }>,
) =>
  canonical(
    permissions.map((p) => ({
      dataActions: [...(p.dataActions ?? [])].sort(),
      notDataActions: [...(p.notDataActions ?? [])].sort(),
    })),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  role: cosmos.GetSqlResourceSqlRoleDefinitionResponse,
  accountId: string,
): SqlRoleDefinition["Attributes"] => ({
  roleDefinitionName: name,
  roleDefinitionId: role.id ?? `${accountId}/sqlRoleDefinitions/${name}`,
  roleName: role.properties?.roleName ?? "",
  account,
  resourceGroup,
  assignableScopes: [...(role.properties?.assignableScopes ?? [])],
});

export const SqlRoleDefinitionProvider = () =>
  Provider.succeed(SqlRoleDefinition, {
    stables: ["roleDefinitionName", "roleDefinitionId", "account", "resourceGroup"],

    // Role definitions disappear with their account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account !== output.account
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      // The GUID is derived from this resource's identity, so a role found
      // under it was created by Alchemy for this resource.
      const name =
        output?.roleDefinitionName ??
        (yield* deterministicGuid(id, instanceId));
      const observed = yield* getRoleDefinition(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      return toAttrs(
        resourceGroup,
        account,
        name,
        observed,
        accountIdOf(subscriptionId, resourceGroup, account),
      );
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DocumentDB");
      const { resourceGroup, account } = news;
      const accountId = accountIdOf(subscriptionId, resourceGroup, account);
      const name =
        output?.roleDefinitionName ??
        (yield* deterministicGuid(id, instanceId));
      const roleName =
        news.roleName ?? output?.roleName ?? (yield* createRoleName(id));
      const assignableScopes = (news.assignableScopes ?? ["/"]).map((s) =>
        expandScope(accountId, s),
      );
      const permissions = toPermissions(news.permissions);
      const get = getRoleDefinition(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      const converged = (
        role: cosmos.GetSqlResourceSqlRoleDefinitionResponse,
      ) =>
        role.properties?.roleName === roleName &&
        normalizeScopes(role.properties?.assignableScopes ?? []) ===
          normalizeScopes(assignableScopes) &&
        permissionsKey(role.properties?.permissions ?? []) ===
          permissionsKey(permissions);

      // Observe.
      let observed = yield* get;

      // Ensure + sync. The PUT is an upsert of the whole definition.
      if (observed === undefined || !converged(observed)) {
        yield* cosmos
          .SqlResourcesCreateUpdateSqlRoleDefinition({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            roleDefinitionId: name,
            properties: {
              roleName,
              type: "CustomRole",
              assignableScopes,
              permissions,
            },
          })
          .pipe(Effect.retry(whileAccountBusy));
        observed = yield* waitForChild(
          `Cosmos DB SQL role definition ${roleName}`,
          get,
          converged,
        );
      }

      return toAttrs(resourceGroup, account, name, observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cosmos
          .DeleteSqlResourceSqlRoleDefinition({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            roleDefinitionId: output.roleDefinitionName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB SQL role definition ${output.roleName}`,
        getRoleDefinition(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.roleDefinitionName,
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.CosmosDB.DatabaseAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
