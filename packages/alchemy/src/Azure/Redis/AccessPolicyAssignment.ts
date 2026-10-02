import * as redisenterprise from "@distilled.cloud/azure/redisenterprise";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { clusterOwnedByStage, lower } from "./Common.ts";

export interface AccessPolicyAssignmentProps {
  /** Resource group of the cluster. Changing it replaces the assignment. */
  resourceGroup: string;
  /** Name of the `Azure.Redis.ManagedRedis` cluster. Changing it replaces the assignment. */
  cluster: string;
  /**
   * Name of the database. Changing it replaces the assignment.
   * @default "default"
   */
  database?: string;
  /**
   * Assignment name: 1-60 letters and digits. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * assignment.
   */
  name?: string;
  /**
   * Access policy granted to the principal. Only `default` (full data
   * access) is supported. Changing it replaces the assignment.
   * @default "default"
   */
  accessPolicyName?: string;
  /**
   * Object (principal) ID of the Microsoft Entra user, group, service
   * principal or managed identity, e.g. a managed identity's
   * `principalId`. Changing it replaces the assignment.
   */
  objectId: string;
}

export interface AccessPolicyAssignment extends Resource<
  "Azure.Redis.AccessPolicyAssignment",
  AccessPolicyAssignmentProps,
  {
    /** Name of the assignment. */
    accessPolicyAssignmentName: string;
    /** ARM resource ID of the assignment. */
    accessPolicyAssignmentId: string;
    /** Name of the cluster. */
    cluster: string;
    /** Name of the database. */
    database: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** Access policy granted. */
    accessPolicyName: string;
    /** Object ID of the principal granted access. */
    objectId: string;
  },
  never,
  Providers
> {}

/**
 * Grants a Microsoft Entra principal data access to an Azure Managed Redis
 * database. Clients authenticate with an Entra token instead of access keys.
 *
 * Assignments have no tags; they belong to the stage that owns their
 * cluster.
 *
 * @see https://learn.microsoft.com/azure/redis/entra-for-authentication
 *
 * ### Granting Access
 * **Example:** Let a managed identity use the database
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("app", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const redis = yield* Azure.Redis.ManagedRedis("cache", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const db = yield* Azure.Redis.ManagedRedisDatabase("db", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: redis.clusterName,
 * });
 * yield* Azure.Redis.AccessPolicyAssignment("app-access", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: redis.clusterName,
 *   database: db.databaseName,
 *   objectId: identity.principalId,
 * });
 * ```
 *
 * @resource
 */
export const AccessPolicyAssignment = Resource<AccessPolicyAssignment>(
  "Azure.Redis.AccessPolicyAssignment",
);

const createAssignmentName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 60,
    lowercase: true,
    delimiter: "",
  });
  return name.replace(/[^a-z0-9]/g, "");
});

const getAssignment = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  databaseName: string,
  accessPolicyAssignmentName: string,
) =>
  orUndefinedIfNotFound(
    redisenterprise.GetAccessPolicyAssignment({
      subscriptionId,
      resourceGroupName,
      clusterName,
      databaseName,
      accessPolicyAssignmentName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  database: string,
  name: string,
  assignment: redisenterprise.GetAccessPolicyAssignmentResponse,
): AccessPolicyAssignment["Attributes"] => ({
  accessPolicyAssignmentName: name,
  accessPolicyAssignmentId: assignment.id ?? "",
  cluster,
  database,
  resourceGroup,
  accessPolicyName: assignment.properties?.accessPolicyName ?? "default",
  objectId: assignment.properties?.user?.objectId ?? "",
});

export const AccessPolicyAssignmentProvider = () =>
  Provider.succeed(AccessPolicyAssignment, {
    stables: [
      "accessPolicyAssignmentName",
      "accessPolicyAssignmentId",
      "cluster",
      "database",
      "resourceGroup",
      "accessPolicyName",
      "objectId",
    ],

    // Assignments live inside a database; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.cluster) !== lower(output.cluster) ||
        lower(news.database ?? "default") !== lower(output.database) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.accessPolicyAssignmentName)) ||
        (news.accessPolicyName ?? "default") !== output.accessPolicyName ||
        lower(news.objectId) !== lower(output.objectId)
      ) {
        // A principal can hold one assignment per database.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      if (resourceGroup === undefined || cluster === undefined) {
        return undefined;
      }
      const database = output?.database ?? olds?.database ?? "default";
      const name =
        output?.accessPolicyAssignmentName ??
        olds?.name ??
        (yield* createAssignmentName(id));
      const observed = yield* getAssignment(
        subscriptionId,
        resourceGroup,
        cluster,
        database,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, database, name, observed);
      return (yield* clusterOwnedByStage(
        subscriptionId,
        resourceGroup,
        cluster,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Cache");
      const { resourceGroup, cluster } = news;
      const database = news.database ?? "default";
      const name =
        news.name ??
        output?.accessPolicyAssignmentName ??
        (yield* createAssignmentName(id));
      const get = getAssignment(
        subscriptionId,
        resourceGroup,
        cluster,
        database,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure. Existence-only: every property is immutable.
      if (observed === undefined) {
        yield* redisenterprise.AccessPolicyAssignmentCreateUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          clusterName: cluster,
          databaseName: database,
          accessPolicyAssignmentName: name,
          properties: {
            accessPolicyName: news.accessPolicyName ?? "default",
            user: { objectId: news.objectId },
          },
        });
      }
      const fresh = yield* waitForProvisioned(
        `redis access policy assignment ${name}`,
        get,
        (assignment) => assignment.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, cluster, database, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        redisenterprise.DeleteAccessPolicyAssignment({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.cluster,
          databaseName: output.database,
          accessPolicyAssignmentName: output.accessPolicyAssignmentName,
        }),
      );
      yield* waitUntilGone(
        `redis access policy assignment ${output.accessPolicyAssignmentName}`,
        getAssignment(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.database,
          output.accessPolicyAssignmentName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Redis.ManagedRedisDatabase",
        "Azure.Redis.ManagedRedis",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
