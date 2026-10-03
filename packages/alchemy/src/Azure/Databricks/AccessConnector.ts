import * as databricks from "@distilled.cloud/azure/databricks";
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

/** Managed identity of an access connector. */
export interface AccessConnectorIdentity {
  /**
   * Identity type. `SystemAssigned` creates a service principal tied to the
   * connector; `UserAssigned` uses the identities in
   * `userAssignedIdentityIds`.
   * @default "SystemAssigned"
   */
  type:
    | "SystemAssigned"
    | "UserAssigned"
    | "SystemAssigned,UserAssigned"
    | "None";
  /**
   * ARM resource IDs of user-assigned managed identities to attach. Required
   * when `type` includes `UserAssigned`.
   */
  userAssignedIdentityIds?: string[];
}

export interface AccessConnectorProps {
  /**
   * Resource group the connector is created in. Changing it replaces the
   * connector.
   */
  resourceGroup: string;
  /**
   * Name of the connector, 3-64 characters of letters, digits, `-`, and
   * `_`. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the connector.
   */
  name?: string;
  /**
   * Azure location of the connector. Changing it replaces the connector.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Managed identity Databricks uses (via Unity Catalog storage credentials)
   * to reach Azure resources such as ADLS Gen2 storage accounts.
   * @default { type: "SystemAssigned" }
   */
  identity?: AccessConnectorIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AccessConnector extends Resource<
  "Azure.Databricks.AccessConnector",
  AccessConnectorProps,
  {
    /** Name of the connector. */
    accessConnectorName: string;
    /** ARM resource ID of the connector. */
    accessConnectorId: string;
    /** Resource group that holds the connector. */
    resourceGroup: string;
    /** Location of the connector. */
    location: string;
    /** Identity type of the connector. */
    identityType: string;
    /**
     * Object ID of the system-assigned identity's service principal, when
     * the connector has one. Grant it roles (e.g. Storage Blob Data
     * Contributor) on the storage Unity Catalog uses.
     */
    principalId: string | undefined;
    /** Microsoft Entra tenant of the system-assigned identity. */
    tenantId: string | undefined;
    /** ARM IDs of the attached user-assigned identities. */
    userAssignedIdentityIds: string[];
    /** ARM IDs of the Databricks workspaces that reference the connector. */
    referedBy: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Databricks access connector — a first-party resource that holds
 * a managed identity Azure Databricks uses to reach other Azure resources
 * (for example ADLS Gen2 storage behind a Unity Catalog metastore or
 * storage credential). Free; it has no running compute.
 *
 * @see https://learn.microsoft.com/azure/databricks/connect/unity-catalog/cloud-storage/azure-managed-identities
 *
 * ### Creating an Access Connector
 * **Example:** Connector with a system-assigned identity
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("analytics");
 * const connector = yield* Azure.Databricks.AccessConnector("uc", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Connector with a user-assigned identity
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("uc-id", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const connector = yield* Azure.Databricks.AccessConnector("uc", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: {
 *     type: "UserAssigned",
 *     userAssignedIdentityIds: [identity.identityId],
 *   },
 * });
 * ```
 *
 * ### Granting Storage Access
 * **Example:** Let the connector read and write a data lake
 * ```typescript
 * yield* Azure.Authorization.RoleAssignment("uc-lake", {
 *   scope: lake.storageAccountId,
 *   roleDefinitionId:
 *     Azure.Authorization.BuiltInRole.StorageBlobDataContributor,
 *   principalId: connector.principalId!,
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * @resource
 */
export const AccessConnector = Resource<AccessConnector>(
  "Azure.Databricks.AccessConnector",
);

type Observed = databricks.GetAccessConnectorResponse;

const getConnector = (
  subscriptionId: string,
  resourceGroupName: string,
  connectorName: string,
) =>
  orUndefinedIfNotFound(
    databricks.GetAccessConnector({
      subscriptionId,
      resourceGroupName,
      connectorName,
    }),
  );

const createName = (id: string) => createPhysicalName({ id, maxLength: 64 });

const observedUserIdentities = (connector: Observed) =>
  Object.entries(connector.identity?.userAssignedIdentities ?? {})
    .filter(([, value]) => value !== null)
    .map(([key]) => key);

const toAttrs = (
  resourceGroup: string,
  name: string,
  connector: Observed,
): AccessConnector["Attributes"] => ({
  accessConnectorName: name,
  accessConnectorId: connector.id ?? "",
  resourceGroup,
  location: connector.location,
  identityType: connector.identity?.type ?? "None",
  principalId: connector.identity?.principalId,
  tenantId: connector.identity?.tenantId,
  userAssignedIdentityIds: observedUserIdentities(connector),
  referedBy: [...(connector.properties?.referedBy ?? [])],
  tags: userTags(connector.tags),
});

const lower = (value: string | undefined) => value?.toLowerCase();

/** Normalized identity type: ARM echoes `SystemAssigned, UserAssigned`. */
const normType = (value: string | undefined) =>
  (value ?? "None").replaceAll(" ", "").toLowerCase();

const sameIdSet = (a: readonly string[], b: readonly string[]) => {
  const left = new Set(a.map((x) => x.toLowerCase()));
  const right = new Set(b.map((x) => x.toLowerCase()));
  return left.size === right.size && [...left].every((x) => right.has(x));
};

export const AccessConnectorProvider = () =>
  Provider.succeed(AccessConnector, {
    stables: [
      "accessConnectorName",
      "accessConnectorId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* databricks
        .ListAccessConnectorBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAccessConnectorBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((connector) => {
        const group = resourceGroupOf(connector.id);
        return hasAnyAlchemyTag(connector.tags) &&
          group !== undefined &&
          connector.name !== undefined
          ? [toAttrs(group, connector.name, connector)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.accessConnectorName)) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location))
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
        output?.accessConnectorName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getConnector(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Databricks");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.accessConnectorName ?? (yield* createName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identityType = news.identity?.type ?? "SystemAssigned";
      const desiredUserIds = news.identity?.userAssignedIdentityIds ?? [];
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        connectorName: name,
      };
      const label = `Databricks access connector ${name}`;
      const get = getConnector(subscriptionId, resourceGroup, name);
      const identityFor = (current: Observed | undefined) => {
        // Without `UserAssigned` in the type, ARM drops all user identities.
        if (!identityType.includes("UserAssigned")) {
          return { type: identityType };
        }
        const userAssignedIdentities: Record<string, {} | null> = {};
        for (const userId of desiredUserIds)
          userAssignedIdentities[userId] = {};
        // Detach identities that are no longer desired.
        for (const existing of current ? observedUserIdentities(current) : []) {
          if (
            !desiredUserIds.some(
              (d) => d.toLowerCase() === existing.toLowerCase(),
            )
          ) {
            userAssignedIdentities[existing] = null;
          }
        }
        return {
          type: identityType,
          userAssignedIdentities:
            Object.keys(userAssignedIdentities).length > 0
              ? userAssignedIdentities
              : undefined,
        };
      };

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* databricks.AccessConnectorsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {},
          identity: identityFor(undefined),
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (connector) => connector.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );

      // Sync identity and tags against observed state.
      const identityChanged =
        normType(observed.identity?.type) !== normType(identityType) ||
        !sameIdSet(observedUserIdentities(observed), desiredUserIds);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (identityChanged || tagsChanged) {
        yield* databricks.UpdateAccessConnector({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged ? identityFor(observed) : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (connector) => connector.properties?.provisioningState,
          { interval: "3 seconds", times: 60 },
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        databricks.DeleteAccessConnector({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          connectorName: output.accessConnectorName,
        }),
      );
      yield* waitUntilGone(
        `Databricks access connector ${output.accessConnectorName}`,
        getConnector(
          subscriptionId,
          output.resourceGroup,
          output.accessConnectorName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
