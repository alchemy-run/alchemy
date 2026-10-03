import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
import type { MongoRoleReference } from "./MongoRoleDefinition.ts";
import {
  canonical,
  isOwnedChild,
  waitForChild,
  whileAccountBusy,
} from "./Shared.ts";

export interface MongoUserDefinitionProps {
  /** Resource group of the account. Changing it replaces the user. */
  resourceGroup: string;
  /**
   * Name of a Cosmos DB for MongoDB (RU) account with the
   * `EnableMongoRoleBasedAccessControl` capability. Changing it replaces
   * the user.
   */
  account: string;
  /** Database the user is defined in. Changing it replaces the user. */
  databaseName: string;
  /**
   * User name. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the user.
   */
  userName?: string;
  /** Password of the user. Changing it updates the user in place. */
  password: Redacted.Redacted<string>;
  /**
   * Roles granted to the user: built-in MongoDB roles (`read`,
   * `readWrite`, `dbAdmin`, …) or custom roles from
   * {@link MongoRoleDefinition}. Updated in place.
   */
  roles: MongoRoleReference[];
  /** Free-form custom data stored with the user. Updated in place. */
  customData?: string;
  /**
   * Authentication mechanism; Cosmos DB supports only `SCRAM-SHA-256`.
   * @default "SCRAM-SHA-256"
   */
  mechanisms?: string;
}

export interface MongoUserDefinition extends Resource<
  "Azure.CosmosDB.MongoUserDefinition",
  MongoUserDefinitionProps,
  {
    /** User definition ID, `{databaseName}.{userName}`. */
    userDefinitionName: string;
    /** Full ARM ID of the user definition. */
    userDefinitionId: string;
    /** Name of the user. */
    userName: string;
    /** Database the user is defined in. */
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
 * A MongoDB user in an Azure Cosmos DB for MongoDB (RU) account that uses
 * native MongoDB role-based access control. Clients authenticate with the
 * user name and password over SCRAM-SHA-256.
 *
 * The account needs the `EnableMongoRoleBasedAccessControl` capability.
 * Cosmos DB never returns the password, so Alchemy re-sends it whenever it
 * changes. Users cannot be tagged; Alchemy treats one it created (or one
 * under a generated name) as its own.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/mongodb/how-to-setup-rbac
 *
 * ### Creating a User
 * **Example:** Read-write user on one database
 * ```typescript
 * const user = yield* Azure.CosmosDB.MongoUserDefinition("api", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   databaseName: "shop",
 *   userName: "api",
 *   password: yield* Config.redacted("MONGO_API_PASSWORD"),
 *   roles: [{ db: "shop", role: "readWrite" }],
 * });
 * ```
 *
 * **Example:** User holding a custom role
 * ```typescript
 * yield* Azure.CosmosDB.MongoUserDefinition("reporting", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   databaseName: "shop",
 *   password: yield* Config.redacted("MONGO_REPORTING_PASSWORD"),
 *   roles: [{ db: "shop", role: reader.roleName }],
 * });
 * ```
 *
 * @resource
 */
export const MongoUserDefinition = Resource<MongoUserDefinition>(
  "Azure.CosmosDB.MongoUserDefinition",
);

type ObservedUser = cosmos.GetMongoDBResourceMongoUserDefinitionResponse;

const createUserName = Effect.fn(function* (id: string) {
  return (yield* createPhysicalName({ id, maxLength: 64 })).replace(
    /[^A-Za-z0-9_-]/g,
    "-",
  );
});

const getUser = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  mongoUserDefinitionId: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetMongoDBResourceMongoUserDefinition({
      subscriptionId,
      resourceGroupName,
      accountName,
      mongoUserDefinitionId,
    }),
  );

const rolesKey = (roles: ReadonlyArray<{ db?: string; role?: string }>) =>
  canonical(
    roles.map((r) => `${r.db ?? ""}.${r.role ?? ""}`.toLowerCase()).sort(),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  databaseName: string,
  userName: string,
  user: ObservedUser,
): MongoUserDefinition["Attributes"] => ({
  userDefinitionName: `${databaseName}.${userName}`,
  userDefinitionId: user.id ?? "",
  userName,
  databaseName,
  account,
  resourceGroup,
});

export const MongoUserDefinitionProvider = () =>
  Provider.succeed(MongoUserDefinition, {
    stables: [
      "userDefinitionName",
      "userDefinitionId",
      "userName",
      "databaseName",
      "account",
      "resourceGroup",
    ],

    // Users disappear with their account.
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
        (news.userName !== undefined && news.userName !== output.userName)
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
      const userName =
        output?.userName ?? olds?.userName ?? (yield* createUserName(id));
      const observed = yield* getUser(
        subscriptionId,
        resourceGroup,
        account,
        `${databaseName}.${userName}`,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        account,
        databaseName,
        userName,
        observed,
      );
      return isOwnedChild(output, olds?.userName) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DocumentDB");
      const { resourceGroup, account, databaseName } = news;
      const userName =
        news.userName ?? output?.userName ?? (yield* createUserName(id));
      const definitionId = `${databaseName}.${userName}`;
      const roles = news.roles.map((r) => ({ db: r.db, role: r.role }));
      const mechanisms = news.mechanisms ?? "SCRAM-SHA-256";
      const get = getUser(subscriptionId, resourceGroup, account, definitionId);
      const converged = (user: ObservedUser) =>
        rolesKey(user.properties?.roles ?? []) === rolesKey(roles) &&
        (user.properties?.customData ?? "") === (news.customData ?? "");
      // The password is never returned; `olds` is the only hint that the
      // deployed password is current. Without it (adoption), re-send it.
      const passwordCurrent =
        olds !== undefined &&
        Redacted.value(olds.password) === Redacted.value(news.password);

      // Observe.
      let observed = yield* get;

      // Ensure + sync. The PUT is an upsert of the whole user.
      if (observed === undefined || !converged(observed) || !passwordCurrent) {
        yield* cosmos
          .MongoDBResourcesCreateUpdateMongoUserDefinition({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            mongoUserDefinitionId: definitionId,
            properties: {
              userName,
              password: news.password,
              databaseName,
              customData: news.customData ?? "",
              roles,
              mechanisms,
            },
          })
          .pipe(Effect.retry(whileAccountBusy));
        observed = yield* waitForChild(
          `Cosmos DB MongoDB user ${definitionId}`,
          get,
          converged,
        );
      }

      return toAttrs(resourceGroup, account, databaseName, userName, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cosmos
          .DeleteMongoDBResourceMongoUserDefinition({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            mongoUserDefinitionId: output.userDefinitionName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB MongoDB user ${output.userDefinitionName}`,
        getUser(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.userDefinitionName,
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.CosmosDB.MongoRoleDefinition",
        "Azure.CosmosDB.DatabaseAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
