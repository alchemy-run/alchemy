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

export interface MongoMIRoleAssignmentProps {
  /** Resource group of the account. Changing it replaces the assignment. */
  resourceGroup: string;
  /** Name of the Cosmos DB account. Changing it replaces the assignment. */
  account: string;
  /**
   * Role to grant: a built-in or custom role's GUID, or a
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
   * Data-plane scope, relative to the account (`/`, `/dbs/{database}`,
   * `/dbs/{database}/colls/{collection}`) or as a full ARM ID. Changing it
   * replaces the assignment.
   * @default "/" (the whole account)
   */
  scope?: string;
}

export interface MongoMIRoleAssignment extends Resource<
  "Azure.CosmosDB.MongoMIRoleAssignment",
  MongoMIRoleAssignmentProps,
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
 * Grants a Cosmos DB for MongoDB (Microsoft Entra ID) data-plane role to a Microsoft
 * Entra principal — the keyless way for a managed identity to read and
 * write documents.
 *
 * Cosmos DB role assignments cannot be tagged; the assignment's GUID is
 * derived from the stack, stage, logical ID, and instance ID, which marks
 * it as owned by Alchemy.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/mongodb/introduction
 *
 * ### Granting Data Access
 * **Example:** Let a managed identity read and write one database
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("api", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.CosmosDB.MongoMIRoleAssignment("api-writes-orders", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   roleDefinitionId: writer.roleDefinitionId,
 *   principalId: identity.principalId,
 *   scope: "/dbs/app",
 * });
 * ```
 *
 * **Example:** Assign a custom role on the whole account
 * ```typescript
 * yield* Azure.CosmosDB.MongoMIRoleAssignment("api-reads", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   roleDefinitionId: reader.roleDefinitionId,
 *   principalId: identity.principalId,
 * });
 * ```
 *
 * @resource
 */
export const MongoMIRoleAssignment = Resource<MongoMIRoleAssignment>(
  "Azure.CosmosDB.MongoMIRoleAssignment",
);

export class MongoMIRoleAssignmentScopeNotFound extends Data.TaggedError(
  "Azure.CosmosDB.MongoMIRoleAssignmentScopeNotFound",
)<{
  readonly scope: string;
  readonly message: string;
}> {}

/**
 * Cosmos accepts an assignment on a database or collection that does not exist,
 * then silently drops it in the background. Check the scope first so the
 * failure is immediate and explicit.
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
  const [, databaseName, collName] = match;
  const found = collName
    ? yield* orUndefinedIfNotFound(
        cosmos.GetMongoDBResourceMongoDBCollection({
          ...where,
          databaseName: databaseName!,
          collectionName: collName,
        }),
      )
    : yield* orUndefinedIfNotFound(
        cosmos.GetMongoDBResourceMongoDBDatabase({
          ...where,
          databaseName: databaseName!,
        }),
      );
  if (found === undefined) {
    return yield* new MongoMIRoleAssignmentScopeNotFound({
      scope,
      message: `Cosmos DB role assignment scope ${scope} does not exist; create the database or collection first`,
    });
  }
});

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Expand a bare role GUID to the account's role-definition ID. */
const roleDefinitionIdOf = (accountId: string, role: string) =>
  GUID.test(role) ? `${accountId}/mongoMIRoleDefinitions/${role}` : role;

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
    cosmos.GetMongoMIResourceMongoMIRoleAssignment({
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
  assignment: cosmos.GetMongoMIResourceMongoMIRoleAssignmentResponse,
  accountId: string,
): MongoMIRoleAssignment["Attributes"] => ({
  roleAssignmentName: name,
  roleAssignmentId:
    assignment.id ?? `${accountId}/mongoMIRoleAssignments/${name}`,
  roleDefinitionId: assignment.properties?.roleDefinitionId ?? "",
  principalId: assignment.properties?.principalId ?? "",
  scope: assignment.properties?.scope ?? accountId,
  account,
  resourceGroup,
});

export const MongoMIRoleAssignmentProvider = () =>
  Provider.succeed(MongoMIRoleAssignment, {
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
        /\/mongoMIRoleAssignments\/[^/]+$/i,
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
          .MongoMIResourcesCreateUpdateMongoMIRoleAssignment({
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
          `Cosmos DB MongoMI role assignment ${name}`,
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
          .DeleteMongoMIResourceMongoMIRoleAssignment({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            roleAssignmentId: output.roleAssignmentName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB MongoMI role assignment ${output.roleAssignmentName}`,
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
        "Azure.CosmosDB.MongoMIRoleDefinition",
        "Azure.CosmosDB.DatabaseAccount",
        "Azure.ManagedIdentity.UserAssignedIdentity",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
