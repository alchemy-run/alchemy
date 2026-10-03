import * as datamigration from "@distilled.cloud/azure/datamigration";
import * as Effect from "effect/Effect";
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

export interface MigrationServiceProps {
  /**
   * Resource group the service is created in. Changing it replaces the
   * service.
   */
  resourceGroup: string;
  /**
   * Name of the migration service, 3-63 characters of letters, digits
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

export interface MigrationService extends Resource<
  "Azure.DataMigration.MigrationService",
  MigrationServiceProps,
  {
    /** Name of the migration service. */
    migrationServiceName: string;
    /** Resource group that holds the service. */
    resourceGroup: string;
    /** ARM resource ID of the service. */
    migrationServiceId: string;
    /** Location of the service. */
    location: string;
    /** Provisioning state reported by ARM (`Succeeded` once usable). */
    provisioningState: string | undefined;
    /**
     * State of the integration runtime attached to the service, as
     * reported by Azure.
     */
    integrationRuntimeState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Database Migration Service migration service — the
 * control-plane resource that drives MongoDB to Azure Cosmos DB (RU or
 * vCore) migrations from the Azure Cosmos DB migration extension. The
 * service itself is free; database migrations run against it.
 *
 * @see https://learn.microsoft.com/azure/dms/dms-overview
 *
 * ### Creating a Migration Service
 * **Example:** Service in a resource group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("migrations");
 * const service = yield* Azure.DataMigration.MigrationService("mongo", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Service with tags
 * ```typescript
 * const service = yield* Azure.DataMigration.MigrationService("mongo", {
 *   resourceGroup: group.resourceGroupName,
 *   tags: { team: "data" },
 * });
 * ```
 *
 * @resource
 */
export const MigrationService = Resource<MigrationService>(
  "Azure.DataMigration.MigrationService",
);

type ObservedService = datamigration.GetMigrationServiceResponse;

const physicalName = (id: string) =>
  createPhysicalName({ id, maxLength: 63, lowercase: true });

const getService = (
  subscriptionId: string,
  resourceGroupName: string,
  migrationServiceName: string,
) =>
  orUndefinedIfNotFound(
    datamigration.GetMigrationService({
      subscriptionId,
      resourceGroupName,
      migrationServiceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  service: ObservedService,
): MigrationService["Attributes"] => ({
  migrationServiceName: name,
  resourceGroup,
  migrationServiceId: service.id ?? "",
  location: service.location,
  provisioningState: service.properties?.provisioningState,
  integrationRuntimeState: service.properties?.integrationRuntimeState,
  tags: userTags(service.tags),
});

export const MigrationServiceProvider = () =>
  Provider.succeed(MigrationService, {
    stables: [
      "migrationServiceName",
      "resourceGroup",
      "migrationServiceId",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* datamigration
        .ListMigrationServiceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListMigrationServiceBySubscription", page),
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
            output.migrationServiceName.toLowerCase()) ||
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
        output?.migrationServiceName ?? olds?.name ?? (yield* physicalName(id));
      const observed = yield* getService(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.DataMigration");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.migrationServiceName ?? (yield* physicalName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const get = getService(subscriptionId, resourceGroup, name);
      const wait = () =>
        waitForProvisioned(
          `migration service ${name}`,
          get,
          (s) => s.properties?.provisioningState,
          { times: 60 },
        );

      // Observe.
      let observed = yield* get;

      // Ensure: PUT is a long-running operation; poll until Succeeded.
      if (observed === undefined) {
        yield* datamigration.MigrationServicesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          migrationServiceName: name,
          location,
          tags,
          properties: {},
        });
        observed = yield* wait();
      } else if (observed.properties?.provisioningState !== "Succeeded") {
        observed = yield* wait();
      }

      // Sync tags against observed cloud tags. The PATCH endpoint fails with
      // "did not return valid location header" (InternalServerError), so
      // re-PUT the full resource instead.
      if (tagsDiffer(observed.tags, tags)) {
        yield* datamigration.MigrationServicesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          migrationServiceName: name,
          location: observed.location,
          tags,
          properties: {},
        });
        observed = yield* wait();
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        datamigration.DeleteMigrationService({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          migrationServiceName: output.migrationServiceName,
        }),
      );
      yield* waitUntilGone(
        `migration service ${output.migrationServiceName}`,
        getService(
          subscriptionId,
          output.resourceGroup,
          output.migrationServiceName,
        ),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
