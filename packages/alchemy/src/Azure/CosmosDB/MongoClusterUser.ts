import * as mongocluster from "@distilled.cloud/azure/mongocluster";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { whileMongoClusterBusy } from "./MongoShared.ts";

export interface MongoClusterUserRole {
  /** Database the role applies to. Only `admin` is supported today. */
  db: string;
  /** Built-in role. Only `root` is supported today. */
  role: "root" | (string & {});
}

export interface MongoClusterUserProps {
  /** Resource group of the cluster. Changing it replaces the user. */
  resourceGroup: string;
  /** Name of the parent cluster, e.g. `cluster.mongoClusterName`. Changing it replaces the user. */
  cluster: string;
  /**
   * Object (principal) ID of the Entra user, group, or service principal,
   * e.g. a managed identity's `principalId`. It is the user's name on the
   * cluster. Changing it replaces the user.
   */
  principalId: string;
  /**
   * Kind of Entra principal. Use `servicePrincipal` for managed identities
   * and app registrations. Changing it replaces the user.
   */
  principalType: "user" | "servicePrincipal";
  /**
   * Database roles granted to the principal.
   * @default [{ db: "admin", role: "root" }]
   */
  roles?: MongoClusterUserRole[];
}

export interface MongoClusterUser extends Resource<
  "Azure.CosmosDB.MongoClusterUser",
  MongoClusterUserProps,
  {
    /** Name of the user on the cluster (the principal's object ID). */
    userName: string;
    /** ARM resource ID of the user. */
    userId: string;
    /** Name of the parent cluster. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** Kind of Entra principal. */
    principalType: string | undefined;
    /** Database roles granted to the principal. */
    roles: MongoClusterUserRole[];
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Entra ID user on an Azure Cosmos DB for MongoDB (vCore)
 * {@link MongoCluster}: grants an Entra principal (user or service principal,
 * e.g. a managed identity) database roles for `MONGODB-OIDC` sign-in. The
 * cluster must allow the `MicrosoftEntraID` auth mode.
 *
 * Users cannot be tagged and are named by the principal ID; Alchemy treats
 * one it created as its own and an existing one as foreign.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/mongodb/vcore/entra-authentication
 *
 * ### Granting Access
 * **Example:** Grant a managed identity root access
 * ```typescript
 * const cluster = yield* Azure.CosmosDB.MongoCluster("db", {
 *   resourceGroup: group.resourceGroupName,
 *   authModes: ["NativeAuth", "MicrosoftEntraID"],
 * });
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("app", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const user = yield* Azure.CosmosDB.MongoClusterUser("app", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.mongoClusterName,
 *   principalId: identity.principalId,
 *   principalType: "servicePrincipal",
 * });
 * ```
 *
 * @resource
 */
export const MongoClusterUser = Resource<MongoClusterUser>(
  "Azure.CosmosDB.MongoClusterUser",
);

const DEFAULT_ROLES: MongoClusterUserRole[] = [{ db: "admin", role: "root" }];

interface UserRef {
  readonly subscriptionId: string;
  readonly resourceGroupName: string;
  readonly mongoClusterName: string;
  readonly userName: string;
}

const getUser = (ref: UserRef) =>
  orUndefinedIfNotFound(mongocluster.GetUser(ref));

type ObservedUser = mongocluster.GetUserResponse;

const rolesKey = (roles: readonly { db: string; role: string }[] | undefined) =>
  (roles ?? [])
    .map((r) => `${r.db}/${r.role}`)
    .sort()
    .join(",");

const rolesMatch = (user: ObservedUser, props: MongoClusterUserProps) =>
  rolesKey(user.properties?.roles) === rolesKey(props.roles ?? DEFAULT_ROLES);

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  name: string,
  user: ObservedUser,
): MongoClusterUser["Attributes"] => ({
  userName: name,
  userId: user.id ?? "",
  cluster,
  resourceGroup,
  principalType: user.properties?.identityProvider?.properties?.principalType,
  roles: (user.properties?.roles ?? []).map((r) => ({
    db: r.db,
    role: r.role,
  })),
  provisioningState: user.properties?.provisioningState,
});

export const MongoClusterUserProvider = () =>
  Provider.succeed(MongoClusterUser, {
    stables: ["userName", "userId", "cluster", "resourceGroup"],

    // Users disappear with their cluster.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.cluster !== output.cluster ||
        news.principalId.toLowerCase() !== output.userName.toLowerCase() ||
        (olds !== undefined && news.principalType !== olds.principalType)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      const name = output?.userName ?? olds?.principalId;
      if (
        resourceGroup === undefined ||
        cluster === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getUser({
        subscriptionId,
        resourceGroupName: resourceGroup,
        mongoClusterName: cluster,
        userName: name,
      });
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, name, observed);
      // Named by the principal: only a user Alchemy recorded is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DocumentDB");
      const { resourceGroup, cluster } = news;
      const name = news.principalId;
      const ref: UserRef = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        mongoClusterName: cluster,
        userName: name,
      };
      const get = getUser(ref);

      // Observe.
      const observed = yield* get;

      // Ensure + sync: roles are only settable through the PUT.
      if (observed === undefined || !rolesMatch(observed, news)) {
        yield* mongocluster
          .UsersCreateOrUpdate({
            ...ref,
            properties: {
              identityProvider: {
                type: "MicrosoftEntraID",
                properties: { principalType: news.principalType },
              },
              roles: news.roles ?? DEFAULT_ROLES,
            },
          })
          .pipe(Effect.retry(whileMongoClusterBusy));
      }
      const settled = yield* waitForProvisioned(
        `Mongo cluster user ${name}`,
        get,
        (user) =>
          rolesMatch(user, news)
            ? user.properties?.provisioningState
            : "Updating",
        { interval: "5 seconds", times: 60 },
      );

      return toAttrs(resourceGroup, cluster, name, settled);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref: UserRef = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        mongoClusterName: output.cluster,
        userName: output.userName,
      };
      yield* ignoreNotFound(
        mongocluster.DeleteUser(ref).pipe(Effect.retry(whileMongoClusterBusy)),
      );
      yield* waitUntilGone(
        `Mongo cluster user ${output.userName}`,
        getUser(ref),
        {
          interval: "5 seconds",
          times: 60,
        },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.CosmosDB.MongoCluster",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
