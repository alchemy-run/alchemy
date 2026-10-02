import * as kusto from "@distilled.cloud/azure/azure_kusto";
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
import type { KustoPrincipalType } from "./ClusterPrincipalAssignment.ts";
import {
  createKustoChildName,
  isClusterOwnedByStack,
  lower,
  whileClusterBusy,
} from "./common.ts";

export type KustoDatabasePrincipalRole = kusto.DatabasePrincipalRole;

export interface DatabasePrincipalAssignmentProps {
  /** Resource group of the cluster. Changing it replaces the assignment. */
  resourceGroup: string;
  /** Name of the cluster. Changing it replaces the assignment. */
  cluster: string;
  /** Name of the database. Changing it replaces the assignment. */
  database: string;
  /**
   * Assignment name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the assignment.
   */
  name?: string;
  /**
   * Principal to grant: an Entra object ID for `User`/`Group`, or an
   * application (client) ID for `App`. Changing it replaces the assignment.
   */
  principalId: string;
  /** Kind of principal. Changing it replaces the assignment. */
  principalType: KustoPrincipalType;
  /**
   * Database role granted to the principal (`Admin`, `Ingestor`, `Monitor`,
   * `User`, `UnrestrictedViewer`, `Viewer`).
   */
  role: KustoDatabasePrincipalRole;
  /**
   * Tenant of the principal. Changing it replaces the assignment.
   * @default the cluster's tenant
   */
  tenantId?: string;
}

export interface DatabasePrincipalAssignment extends Resource<
  "Azure.Kusto.DatabasePrincipalAssignment",
  DatabasePrincipalAssignmentProps,
  {
    /** Name of the assignment. */
    principalAssignmentName: string;
    /** ARM resource ID of the assignment. */
    principalAssignmentId: string;
    /** Cluster of the database. */
    cluster: string;
    /** Database the role is granted on. */
    database: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** Principal granted the role. */
    principalId: string;
    /** Kind of principal. */
    principalType: string;
    /** Granted role. */
    role: string;
    /** Tenant of the principal. */
    tenantId: string | undefined;
    /** Display name of the principal, as resolved by Kusto. */
    principalName: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Grants a user, group, or application a role (`Admin`, `Ingestor`,
 * `Monitor`, `User`, `UnrestrictedViewer`, `Viewer`) on one database of an
 * Azure Data Explorer (Kusto) cluster.
 *
 * @see https://learn.microsoft.com/azure/data-explorer/manage-database-permissions
 *
 * ### Granting Database Access
 * **Example:** Ingestor access for a managed identity
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("reader", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Kusto.DatabasePrincipalAssignment("reader", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   database: db.databaseName,
 *   principalId: identity.clientId,
 *   principalType: "App",
 *   role: "Ingestor",
 * });
 * ```
 *
 * @resource
 */
export const DatabasePrincipalAssignment =
  Resource<DatabasePrincipalAssignment>(
    "Azure.Kusto.DatabasePrincipalAssignment",
  );

const getAssignment = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  databaseName: string,
  principalAssignmentName: string,
) =>
  orUndefinedIfNotFound(
    kusto.GetDatabasePrincipalAssignment({
      subscriptionId,
      resourceGroupName,
      clusterName,
      databaseName,
      principalAssignmentName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  database: string,
  name: string,
  assignment: kusto.GetDatabasePrincipalAssignmentResponse,
): DatabasePrincipalAssignment["Attributes"] => ({
  principalAssignmentName: name,
  principalAssignmentId: assignment.id ?? "",
  cluster,
  database,
  resourceGroup,
  principalId: assignment.properties?.principalId ?? "",
  principalType: assignment.properties?.principalType ?? "",
  role: assignment.properties?.role ?? "",
  tenantId: assignment.properties?.tenantId,
  principalName: assignment.properties?.principalName,
});

export const DatabasePrincipalAssignmentProvider = () =>
  Provider.succeed(DatabasePrincipalAssignment, {
    stables: [
      "principalAssignmentName",
      "principalAssignmentId",
      "cluster",
      "database",
      "resourceGroup",
    ],

    // Assignments live inside a cluster; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      // Kusto may normalize the principal on read, so the identity fields
      // are compared against the previous props.
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.cluster !== output.cluster ||
        news.database !== output.database ||
        (news.name !== undefined &&
          news.name !== output.principalAssignmentName) ||
        (olds !== undefined &&
          (lower(news.principalId) !== lower(olds.principalId) ||
            news.principalType !== olds.principalType ||
            lower(news.tenantId) !== lower(olds.tenantId)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      const database = output?.database ?? olds?.database;
      if (
        resourceGroup === undefined ||
        cluster === undefined ||
        database === undefined
      ) {
        return undefined;
      }
      const name =
        output?.principalAssignmentName ??
        olds?.name ??
        (yield* createKustoChildName(id));
      const observed = yield* getAssignment(
        subscriptionId,
        resourceGroup,
        cluster,
        database,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, database, name, observed);
      return output !== undefined ||
        (yield* isClusterOwnedByStack(subscriptionId, resourceGroup, cluster))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Kusto");
      const { resourceGroup, cluster, database } = news;
      const name =
        news.name ??
        output?.principalAssignmentName ??
        (yield* createKustoChildName(id));
      const get = getAssignment(
        subscriptionId,
        resourceGroup,
        cluster,
        database,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT both creates the assignment and changes its
      // role; skip it when the observed role already matches.
      if (observed === undefined || observed.properties?.role !== news.role) {
        yield* kusto
          .DatabasePrincipalAssignmentsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            clusterName: cluster,
            databaseName: database,
            principalAssignmentName: name,
            properties: {
              principalId: news.principalId,
              principalType: news.principalType,
              role: news.role,
              tenantId: news.tenantId,
            },
          })
          .pipe(Effect.retry(whileClusterBusy));
      }
      const fresh = yield* waitForProvisioned(
        `kusto database principal assignment ${name}`,
        get,
        (a) => a.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, cluster, database, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        kusto
          .DeleteDatabasePrincipalAssignment({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            clusterName: output.cluster,
            databaseName: output.database,
            principalAssignmentName: output.principalAssignmentName,
          })
          .pipe(Effect.retry(whileClusterBusy)),
      );
      yield* waitUntilGone(
        `kusto database principal assignment ${output.principalAssignmentName}`,
        getAssignment(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.database,
          output.principalAssignmentName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
