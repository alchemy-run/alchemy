import * as datamigration from "@distilled.cloud/azure/datamigration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface SqlMigrationServiceProps {
  /**
   * Resource group the service is created in. Changing it replaces the
   * service.
   */
  resourceGroup: string;
  /**
   * Name of the SQL migration service, 3-63 characters of letters, digits
   * and hyphens. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the service.
   */
  name?: string;
  /**
   * Azure location of the service. Changing it replaces the service.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface SqlMigrationService extends Resource<
  "Azure.DataMigration.SqlMigrationService",
  SqlMigrationServiceProps,
  {
    /** Name of the SQL migration service. */
    sqlMigrationServiceName: string;
    /** Resource group that holds the service. */
    resourceGroup: string;
    /** ARM resource ID of the service. */
    sqlMigrationServiceId: string;
    /** Location of the service. */
    location: string;
    /** Provisioning state reported by ARM (`Succeeded` once usable). */
    provisioningState: string | undefined;
    /**
     * State of the self-hosted integration runtime: `NeedRegistration`
     * until a runtime registers with an auth key, then `Online`/`Offline`.
     */
    integrationRuntimeState: string | undefined;
    /** First key a self-hosted integration runtime registers with. */
    authKey1: Redacted.Redacted<string> | undefined;
    /** Second key a self-hosted integration runtime registers with. */
    authKey2: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Database Migration Service SQL migration service — the
 * control-plane resource that the Azure SQL migration extension uses to
 * move SQL Server databases to Azure SQL Database, Azure SQL Managed
 * Instance, or SQL Server on Azure VMs. A self-hosted integration runtime
 * registers against it with one of its auth keys. The service itself is
 * free.
 *
 * @see https://learn.microsoft.com/azure/dms/dms-overview
 *
 * ### Creating a SQL Migration Service
 * **Example:** Service in a resource group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("migrations");
 * const service = yield* Azure.DataMigration.SqlMigrationService("sql", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Service with tags
 * ```typescript
 * const service = yield* Azure.DataMigration.SqlMigrationService("sql", {
 *   resourceGroup: group.resourceGroupName,
 *   tags: { team: "data" },
 * });
 * ```
 *
 * ### Registering an Integration Runtime
 * **Example:** Hand the auth key to the self-hosted integration runtime
 * ```typescript
 * const service = yield* Azure.DataMigration.SqlMigrationService("sql", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * // pass `service.authKey1` (Redacted) to the SHIR installer on the
 * // machine that can reach the source SQL Server
 * ```
 *
 * @resource
 */
export const SqlMigrationService = Resource<SqlMigrationService>(
  "Azure.DataMigration.SqlMigrationService",
);

type ObservedService = datamigration.GetSqlMigrationServiceResponse;

const physicalName = (id: string) =>
  createPhysicalName({ id, maxLength: 63, lowercase: true });

const getService = (
  subscriptionId: string,
  resourceGroupName: string,
  sqlMigrationServiceName: string,
) =>
  orUndefinedIfNotFound(
    datamigration.GetSqlMigrationService({
      subscriptionId,
      resourceGroupName,
      sqlMigrationServiceName,
    }),
  );

const listKeys = (
  subscriptionId: string,
  resourceGroupName: string,
  sqlMigrationServiceName: string,
) =>
  orUndefinedIfNotFound(
    datamigration.ListSqlMigrationServiceAuthKeys({
      subscriptionId,
      resourceGroupName,
      sqlMigrationServiceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  service: ObservedService,
  keys?: datamigration.AuthenticationKeys,
): SqlMigrationService["Attributes"] => ({
  sqlMigrationServiceName: name,
  resourceGroup,
  sqlMigrationServiceId: service.id ?? "",
  location: service.location,
  provisioningState: service.properties?.provisioningState,
  integrationRuntimeState: service.properties?.integrationRuntimeState,
  authKey1: keys?.authKey1 ? Redacted.make(keys.authKey1) : undefined,
  authKey2: keys?.authKey2 ? Redacted.make(keys.authKey2) : undefined,
  tags: userTags(service.tags),
});

export const SqlMigrationServiceProvider = () =>
  Provider.succeed(SqlMigrationService, {
    stables: [
      "sqlMigrationServiceName",
      "resourceGroup",
      "sqlMigrationServiceId",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* datamigration
        .ListSqlMigrationServiceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListSqlMigrationServiceBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((service) => {
        const group = resourceGroupOf(service.id);
        return hasAnyAlchemyTag(service.tags) &&
          group !== undefined &&
          service.name !== undefined
          ? [toAttrs(group, service.name, service)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.sqlMigrationServiceName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.replace(/\s/g, "").toLowerCase() !==
            output.location.replace(/\s/g, "").toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.sqlMigrationServiceName ??
        olds?.name ??
        (yield* physicalName(id));
      const observed = yield* getService(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const keys = yield* listKeys(subscriptionId, resourceGroup, name);
      const attrs = toAttrs(resourceGroup, name, observed, keys);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.DataMigration");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.sqlMigrationServiceName ??
        (yield* physicalName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const get = getService(subscriptionId, resourceGroup, name);
      const wait = () =>
        waitForProvisioned(
          `SQL migration service ${name}`,
          get,
          (s) => s.properties?.provisioningState,
          { times: 60 },
        );

      // Observe.
      let observed = yield* get;

      // Ensure: PUT is a long-running operation; poll until Succeeded.
      if (observed === undefined) {
        yield* datamigration.SqlMigrationServicesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          sqlMigrationServiceName: name,
          location,
          tags,
          properties: {},
        });
        observed = yield* wait();
      } else if (observed.properties?.provisioningState !== "Succeeded") {
        observed = yield* wait();
      }

      // Sync tags against observed cloud tags.
      if (tagsDiffer(observed.tags, tags)) {
        yield* datamigration.UpdateSqlMigrationService({
          subscriptionId,
          resourceGroupName: resourceGroup,
          sqlMigrationServiceName: name,
          tags,
        });
        observed = yield* wait();
      }

      const keys = yield* listKeys(subscriptionId, resourceGroup, name);
      return toAttrs(resourceGroup, name, observed, keys);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        datamigration.DeleteSqlMigrationService({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          sqlMigrationServiceName: output.sqlMigrationServiceName,
        }),
      );
      yield* waitUntilGone(
        `SQL migration service ${output.sqlMigrationServiceName}`,
        getService(
          subscriptionId,
          output.resourceGroup,
          output.sqlMigrationServiceName,
        ),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
