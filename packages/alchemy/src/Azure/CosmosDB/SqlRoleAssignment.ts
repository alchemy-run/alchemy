import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
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
  deterministicGuid,
  expandScope,
  waitForChild,
  whileAccountBusy,
} from "./Shared.ts";

/**
 * Built-in Cosmos DB for NoSQL data-plane roles present on every account.
 * Pass one as {@link SqlRoleAssignmentProps.roleDefinitionId}.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/nosql/reference-data-plane-security#built-in-role-definitions
 */
export const SqlBuiltInRole = {
  /** Read items and metadata. */
  DataReader: "00000000-0000-0000-0000-000000000001",
  /** Read and write items, plus metadata reads. */
  DataContributor: "00000000-0000-0000-0000-000000000002",
} as const;

export interface SqlRoleAssignmentProps {
  /** Resource group of the account. Changing it replaces the assignment. */
  resourceGroup: string;
  /** Name of the Cosmos DB account. Changing it replaces the assignment. */
  account: string;
  /**
   * Role to grant: a {@link SqlBuiltInRole} GUID, a custom role's GUID, or a
   * full role-definition ID such as `role.roleDefinitionId`. Changing it
   * replaces the assignment.
   */
  roleDefinitionId: string;
  /**
   * Object ID of the Microsoft Entra principal receiving the role, e.g.
   * `identity.principalId`. Changing it replaces the assignment.
   */
  principalId: string;
  /**
   * Data-plane scope, relative to the account (`/`, `/dbs/{db}`,
   * `/dbs/{db}/colls/{container}`) or as a full ARM ID. Changing it replaces
   * the assignment.
   * @default "/" (the whole account)
   */
  scope?: string;
}

export interface SqlRoleAssignment extends Resource<
  "Azure.CosmosDB.SqlRoleAssignment",
  SqlRoleAssignmentProps,
  {
    /** Role assignment GUID. */
    roleAssignmentName: string;
    /** Full ARM ID of the role assignment. */
    roleAssignmentId: string;
    /** Full ARM ID of the granted role definition. */
    roleDefinitionId: string;
    /** Principal holding the role. */
    principalId: string;
    /** Full ARM ID of the data-plane scope. */
    scope: string;
    /** Name of the Cosmos DB account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
 * Grants a Cosmos DB for NoSQL data-plane role to a Microsoft Entra
 * principal — the keyless way for a managed identity to read and write
 * items. Pair it with `disableLocalAuth: true` on the account.
 *
 * Cosmos DB role assignments cannot be tagged; the assignment's GUID is
 * derived from the stack, stage, logical ID, and instance ID, which marks
 * it as owned by Alchemy.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/nosql/security/how-to-grant-data-plane-role-based-access
 *
 * ### Granting Data Access
 * **Example:** Let a managed identity read and write one container
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("api", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.CosmosDB.SqlRoleAssignment("api-writes-orders", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   roleDefinitionId: Azure.CosmosDB.SqlBuiltInRole.DataContributor,
 *   principalId: identity.principalId,
 *   scope: "/dbs/app/colls/orders",
 * });
 * ```
 *
 * **Example:** Assign a custom role on the whole account
 * ```typescript
 * yield* Azure.CosmosDB.SqlRoleAssignment("api-reads", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   roleDefinitionId: reader.roleDefinitionId,
 *   principalId: identity.principalId,
 * });
 * ```
 *
 * @resource
 */
export const SqlRoleAssignment = Resource<SqlRoleAssignment>(
  "Azure.CosmosDB.SqlRoleAssignment",
);

export class SqlRoleAssignmentScopeNotFound extends Data.TaggedError(
  "Azure.CosmosDB.SqlRoleAssignmentScopeNotFound",
)<{
  readonly scope: string;
  readonly message: string;
}> {}

/**
 * Cosmos accepts an assignment on a database or container that does not
 * exist, then silently drops it in the background. Check the scope first so
 * the failure is immediate and explicit.
 */
const ensureScopeExists = Effect.fn(function* (
  where: {
    subscriptionId: string;
    resourceGroupName: string;
    accountName: string;
  },
  accountId: string,
  scope: string,
) {
  if (!scope.toLowerCase().startsWith(accountId.toLowerCase())) return;
  const match = scope
    .slice(accountId.length)
    .match(/^\/dbs\/([^/]+)(?:\/colls\/([^/]+))?\/?$/i);
  if (!match) return;
  const [, databaseName, containerName] = match;
  const found = containerName
    ? yield* orUndefinedIfNotFound(
        cosmos.GetSqlResourceSqlContainer({
          ...where,
          databaseName: databaseName!,
          containerName,
        }),
      )
    : yield* orUndefinedIfNotFound(
        cosmos.GetSqlResourceSqlDatabase({
          ...where,
          databaseName: databaseName!,
        }),
      );
  if (found === undefined) {
    return yield* new SqlRoleAssignmentScopeNotFound({
      scope,
      message: `Cosmos DB role assignment scope ${scope} does not exist; create the database or container first`,
    });
  }
});

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Expand a bare role GUID to the account's role-definition ID. */
const roleDefinitionIdOf = (accountId: string, role: string) =>
  GUID.test(role) ? `${accountId}/sqlRoleDefinitions/${role}` : role;

const lastSegment = (id: string) =>
  id.split("/").pop()?.toLowerCase() ?? id.toLowerCase();

const normalizeScope = (scope: string) =>
  scope.replace(/\/+$/, "").toLowerCase();

const getAssignment = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  roleAssignmentId: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetSqlResourceSqlRoleAssignment({
      subscriptionId,
      resourceGroupName,
      accountName,
      roleAssignmentId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  assignment: cosmos.GetSqlResourceSqlRoleAssignmentResponse,
  accountId: string,
): SqlRoleAssignment["Attributes"] => ({
  roleAssignmentName: name,
  roleAssignmentId:
    assignment.id ?? `${accountId}/sqlRoleAssignments/${name}`,
  roleDefinitionId: assignment.properties?.roleDefinitionId ?? "",
  principalId: assignment.properties?.principalId ?? "",
  scope: assignment.properties?.scope ?? accountId,
  account,
  resourceGroup,
});

export const SqlRoleAssignmentProvider = () =>
  Provider.succeed(SqlRoleAssignment, {
    stables: [
      "roleAssignmentName",
      "roleAssignmentId",
      "roleDefinitionId",
      "principalId",
      "scope",
      "account",
      "resourceGroup",
    ],

    // Role assignments disappear with their account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const accountId = output.roleAssignmentId.replace(
        /\/sqlRoleAssignments\/[^/]+$/i,
        "",
      );
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account !== output.account ||
        lastSegment(news.roleDefinitionId) !==
          lastSegment(output.roleDefinitionId) ||
        news.principalId.toLowerCase() !== output.principalId.toLowerCase() ||
        normalizeScope(expandScope(accountId, news.scope ?? "/")) !==
          normalizeScope(output.scope)
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
      // The GUID is derived from this resource's identity, so an assignment
      // found under it was created by Alchemy for this resource.
      const name =
        output?.roleAssignmentName ??
        (yield* deterministicGuid(id, instanceId));
      const observed = yield* getAssignment(
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
        output?.roleAssignmentName ??
        (yield* deterministicGuid(id, instanceId));
      const get = getAssignment(subscriptionId, resourceGroup, account, name);

      // Observe. Everything about an assignment is immutable (changes
      // replace it), so reconcile only ensures it exists.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const scope = expandScope(accountId, news.scope ?? "/");
        yield* ensureScopeExists(
          {
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
          },
          accountId,
          scope,
        );
        yield* cosmos
          .SqlResourcesCreateUpdateSqlRoleAssignment({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            roleAssignmentId: name,
            properties: {
              roleDefinitionId: roleDefinitionIdOf(
                accountId,
                news.roleDefinitionId,
              ),
              principalId: news.principalId,
              scope,
            },
          })
          .pipe(Effect.retry(whileAccountBusy));
        observed = yield* waitForChild(
          `Cosmos DB SQL role assignment ${name}`,
          get,
          () => true,
        );
      }

      return toAttrs(resourceGroup, account, name, observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cosmos
          .DeleteSqlResourceSqlRoleAssignment({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            roleAssignmentId: output.roleAssignmentName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB SQL role assignment ${output.roleAssignmentName}`,
        getAssignment(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.roleAssignmentName,
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.CosmosDB.SqlRoleDefinition",
        "Azure.CosmosDB.DatabaseAccount",
        "Azure.ManagedIdentity.UserAssignedIdentity",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
