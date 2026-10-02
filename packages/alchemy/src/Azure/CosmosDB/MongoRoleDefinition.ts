import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
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
  canonical,
  isOwnedChild,
  waitForChild,
  whileAccountBusy,
} from "./Shared.ts";

export interface MongoPrivilege {
  /**
   * Database and (optionally) collection the actions apply to. Omit
   * `collection` to cover every collection in the database.
   */
  resource: { db: string; collection?: string };
  /** MongoDB actions, e.g. `find`, `insert`, `update`, `remove`. */
  actions: string[];
}

export interface MongoRoleReference {
  /** Database the inherited role is defined in. */
  db: string;
  /** Name of the inherited role, e.g. `read` or `readWrite`. */
  role: string;
}

export interface MongoRoleDefinitionProps {
  /** Resource group of the account. Changing it replaces the role. */
  resourceGroup: string;
  /**
   * Name of a Cosmos DB for MongoDB (RU) account with the
   * `EnableMongoRoleBasedAccessControl` capability. Changing it replaces
   * the role.
   */
  account: string;
  /** Database the role is defined in. Changing it replaces the role. */
  databaseName: string;
  /**
   * Role name (letters, digits, `_`, `-`). If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * role.
   */
  roleName?: string;
  /** Privileges granted by the role. Updated in place. */
  privileges: MongoPrivilege[];
  /** Roles whose privileges this role inherits. Updated in place. */
  roles?: MongoRoleReference[];
}

export interface MongoRoleDefinition extends Resource<
  "Azure.CosmosDB.MongoRoleDefinition",
  MongoRoleDefinitionProps,
  {
    /** Role definition ID, `{databaseName}.{roleName}`. */
    roleDefinitionName: string;
    /** Full ARM ID of the role definition. */
    roleDefinitionId: string;
    /** Name of the role. */
    roleName: string;
    /** Database the role is defined in. */
    databaseName: string;
    /** Name of the Cosmos DB account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
 * A custom MongoDB role in an Azure Cosmos DB for MongoDB (RU) account that
 * uses native MongoDB role-based access control. Grant it to users with
 * {@link MongoUserDefinition}.
 *
 * The account needs the `EnableMongoRoleBasedAccessControl` capability.
 * Cosmos DB does not keep tags on role definitions; Alchemy treats one it
 * created (or one under a generated name) as its own.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/mongodb/how-to-setup-rbac
 *
 * ### Creating a Role
 * **Example:** Read-only role on one collection
 * ```typescript
 * const account = yield* Azure.CosmosDB.DatabaseAccount("mongo", {
 *   resourceGroup: group.resourceGroupName,
 *   kind: "MongoDB",
 *   capabilities: ["EnableServerless", "EnableMongo", "EnableMongoRoleBasedAccessControl"],
 *   serverVersion: "4.2",
 * });
 * const reader = yield* Azure.CosmosDB.MongoRoleDefinition("orders-reader", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   databaseName: "shop",
 *   privileges: [
 *     { resource: { db: "shop", collection: "orders" }, actions: ["find"] },
 *   ],
 * });
 * ```
 *
 * **Example:** Role inheriting a built-in role
 * ```typescript
 * yield* Azure.CosmosDB.MongoRoleDefinition("shop-writer", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   databaseName: "shop",
 *   privileges: [{ resource: { db: "shop" }, actions: ["insert", "update"] }],
 *   roles: [{ db: "shop", role: "read" }],
 * });
 * ```
 *
 * @resource
 */
export const MongoRoleDefinition = Resource<MongoRoleDefinition>(
  "Azure.CosmosDB.MongoRoleDefinition",
);

type ObservedRole = cosmos.GetMongoDBResourceMongoRoleDefinitionResponse;

const createRoleName = Effect.fn(function* (id: string) {
  return (yield* createPhysicalName({ id, maxLength: 64 })).replace(
    /[^A-Za-z0-9_-]/g,
    "-",
  );
});

const getRole = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  mongoRoleDefinitionId: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetMongoDBResourceMongoRoleDefinition({
      subscriptionId,
      resourceGroupName,
      accountName,
      mongoRoleDefinitionId,
    }),
  );

const privilegesKey = (
  privileges: ReadonlyArray<{
    resource?: { db?: string; collection?: string };
    actions?: readonly string[];
  }>,
) =>
  canonical(
    privileges
      .map((p) => ({
        db: p.resource?.db ?? "",
        collection: p.resource?.collection ?? "",
        actions: [...(p.actions ?? [])].sort(),
      }))
      .sort((a, b) =>
        `${a.db}/${a.collection}` < `${b.db}/${b.collection}` ? -1 : 1,
      ),
  );

const rolesKey = (roles: ReadonlyArray<{ db?: string; role?: string }>) =>
  canonical(
    roles.map((r) => `${r.db ?? ""}.${r.role ?? ""}`.toLowerCase()).sort(),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  databaseName: string,
  roleName: string,
  role: ObservedRole,
): MongoRoleDefinition["Attributes"] => ({
  roleDefinitionName: `${databaseName}.${roleName}`,
  roleDefinitionId: role.id ?? "",
  roleName,
  databaseName,
  account,
  resourceGroup,
});

export const MongoRoleDefinitionProvider = () =>
  Provider.succeed(MongoRoleDefinition, {
    stables: [
      "roleDefinitionName",
      "roleDefinitionId",
      "roleName",
      "databaseName",
      "account",
      "resourceGroup",
    ],

    // Role definitions disappear with their account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account !== output.account ||
        news.databaseName !== output.databaseName ||
        (news.roleName !== undefined && news.roleName !== output.roleName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      const databaseName = output?.databaseName ?? olds?.databaseName;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        databaseName === undefined
      ) {
        return undefined;
      }
      const roleName =
        output?.roleName ?? olds?.roleName ?? (yield* createRoleName(id));
      const observed = yield* getRole(
        subscriptionId,
        resourceGroup,
        account,
        `${databaseName}.${roleName}`,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        account,
        databaseName,
        roleName,
        observed,
      );
      return isOwnedChild(output, olds?.roleName) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DocumentDB");
      const { resourceGroup, account, databaseName } = news;
      const roleName =
        news.roleName ?? output?.roleName ?? (yield* createRoleName(id));
      const definitionId = `${databaseName}.${roleName}`;
      const privileges = news.privileges.map((p) => ({
        resource: { db: p.resource.db, collection: p.resource.collection },
        actions: [...p.actions],
      }));
      const roles = (news.roles ?? []).map((r) => ({ db: r.db, role: r.role }));
      const get = getRole(subscriptionId, resourceGroup, account, definitionId);
      const converged = (role: ObservedRole) =>
        privilegesKey(role.properties?.privileges ?? []) ===
          privilegesKey(privileges) &&
        rolesKey(role.properties?.roles ?? []) === rolesKey(roles);

      // Observe.
      let observed = yield* get;

      // Ensure + sync. The PUT is an upsert of the whole definition.
      if (observed === undefined || !converged(observed)) {
        yield* cosmos
          .MongoDBResourcesCreateUpdateMongoRoleDefinition({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            mongoRoleDefinitionId: definitionId,
            properties: {
              roleName,
              type: "CustomRole",
              databaseName,
              privileges,
              roles,
            },
          })
          .pipe(Effect.retry(whileAccountBusy));
        observed = yield* waitForChild(
          `Cosmos DB MongoDB role ${definitionId}`,
          get,
          converged,
        );
      }

      return toAttrs(resourceGroup, account, databaseName, roleName, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cosmos
          .DeleteMongoDBResourceMongoRoleDefinition({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            mongoRoleDefinitionId: output.roleDefinitionName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB MongoDB role ${output.roleDefinitionName}`,
        getRole(
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
