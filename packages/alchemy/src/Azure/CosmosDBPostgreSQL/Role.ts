import * as postgresqlhsc from "@distilled.cloud/azure/postgresqlhsc";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
import {
  type ClusterRef,
  clusterOwnedByStack,
  COSMOS_POSTGRES_NAMESPACE,
  generatePassword,
  reveal,
  sameText,
  whileClusterBusy,
} from "./common.ts";

export interface RoleProps {
  /** Resource group of the cluster. Changing it replaces the role. */
  resourceGroup: string;
  /** Name of the cluster. Changing it replaces the role. */
  cluster: string;
  /**
   * PostgreSQL role name: lowercase letters, digits, and `_` (up to 63
   * characters, not starting with `pg_` or `citus`). If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the role.
   */
  name?: string;
  /**
   * Password of the role. If omitted, a random password is generated on
   * create and exposed as an attribute. Changing it updates the role in
   * place.
   */
  password?: Redacted.Redacted<string>;
}

export interface Role extends Resource<
  "Azure.CosmosDBPostgreSQL.Role",
  RoleProps,
  {
    /** Name of the role. */
    roleName: string;
    /** ARM resource ID of the role. */
    roleId: string;
    /** Name of the cluster. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /**
     * Password last applied by Alchemy (the given or the generated one).
     * `undefined` for adopted roles.
     */
    password: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * A PostgreSQL login role on every server of an Azure Cosmos DB for
 * PostgreSQL cluster.
 *
 * Roles created through the API can log in with a password and are members
 * of `azure_pg_admin`; grant them table privileges with SQL.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/postgresql/howto-create-users
 *
 * ### Creating Roles
 * **Example:** Role with a generated password
 * ```typescript
 * const app = yield* Azure.CosmosDBPostgreSQL.Role("app", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 * });
 * // app.roleName and app.password (Redacted) log in to the coordinator
 * ```
 *
 * **Example:** Role with an explicit password
 * ```typescript
 * const reporting = yield* Azure.CosmosDBPostgreSQL.Role("reporting", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   name: "reporting",
 *   password: yield* Config.redacted("REPORTING_PASSWORD"),
 * });
 * ```
 *
 * @resource
 */
export const Role = Resource<Role>("Azure.CosmosDBPostgreSQL.Role");

const createRoleName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 63,
    lowercase: true,
    delimiter: "_",
  });
  return name.replace(/[^a-z0-9_]/g, "_");
});

interface RoleRef extends ClusterRef {
  readonly roleName: string;
}

const getRole = (ref: RoleRef) =>
  orUndefinedIfNotFound(postgresqlhsc.GetRole(ref));

const toAttrs = (
  ref: RoleRef,
  role: postgresqlhsc.GetRoleResponse,
  password: Redacted.Redacted<string> | undefined,
): Role["Attributes"] => ({
  roleName: ref.roleName,
  roleId: role.id ?? "",
  cluster: ref.clusterName,
  resourceGroup: ref.resourceGroupName,
  password,
});

export const RoleProvider = () =>
  Provider.succeed(Role, {
    stables: ["roleName", "roleId", "cluster", "resourceGroup"],

    // Roles live inside a cluster; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.cluster, output.cluster) ||
        (news.name !== undefined && news.name !== output.roleName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const clusterName = output?.cluster ?? olds?.cluster;
      if (resourceGroupName === undefined || clusterName === undefined) {
        return undefined;
      }
      const ref: RoleRef = {
        subscriptionId,
        resourceGroupName,
        clusterName,
        roleName: output?.roleName ?? olds?.name ?? (yield* createRoleName(id)),
      };
      const observed = yield* getRole(ref);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(ref, observed, output?.password ?? olds?.password);
      return (yield* clusterOwnedByStack(ref)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, COSMOS_POSTGRES_NAMESPACE);
      const ref: RoleRef = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        clusterName: news.cluster,
        roleName: news.name ?? output?.roleName ?? (yield* createRoleName(id)),
      };
      const label = `Cosmos DB for PostgreSQL role ${ref.roleName}`;

      // Observe. The password is write-only, so the one last applied by
      // Alchemy is the baseline; an adopted role gets the desired one.
      const observed = yield* getRole(ref);
      const applied = output?.password;
      const password = news.password ?? applied ?? (yield* generatePassword);
      const passwordChanged =
        applied === undefined || reveal(password) !== reveal(applied);

      // Ensure + sync: the PUT is an upsert that also resets the password.
      if (observed === undefined || passwordChanged) {
        yield* postgresqlhsc
          .CreateRole({ ...ref, properties: { password } })
          .pipe(Effect.retry(whileClusterBusy));
      }
      const fresh = yield* waitForProvisioned(
        label,
        getRole(ref),
        (role) => role.properties.provisioningState,
        { interval: "10 seconds", times: 60 },
      );
      return toAttrs(ref, fresh, password);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref: RoleRef = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        clusterName: output.cluster,
        roleName: output.roleName,
      };
      yield* ignoreNotFound(
        postgresqlhsc.DeleteRole(ref).pipe(Effect.retry(whileClusterBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB for PostgreSQL role ${output.roleName}`,
        getRole(ref),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.CosmosDBPostgreSQL.Cluster"] },
  });
