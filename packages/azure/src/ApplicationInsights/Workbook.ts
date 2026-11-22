import * as applicationinsights from "@distilled.cloud/azure/applicationinsights";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { deterministicGuid } from "../Authorization/Ownership.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";

/** Managed identity used by a workbook to reach bring-your-own storage. */
export interface WorkbookIdentity {
  /** Identity type: `UserAssigned` or `None`. Workbooks only accept user-assigned identities. */
  type: "UserAssigned" | "None";
  /**
   * ARM resource IDs of the user-assigned identities, e.g.
   * `identity.identityId` of an `Azure.ManagedIdentity.UserAssignedIdentity`.
   * @default []
   */
  userAssignedIdentities?: string[];
}

export interface WorkbookProps {
  /**
   * Resource group the workbook is created in.
   *
   * :::caution
   * Changing it replaces the workbook.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * ARM name of the workbook. Azure requires a GUID.
   *
   * :::caution
   * Changing it replaces the workbook.
   * :::
   * @default a GUID derived from the stack, stage, logical ID, and instance ID
   */
  name?: string;
  /**
   * Azure location of the workbook, e.g. `eastus`.
   *
   * :::caution
   * Changing it replaces the workbook.
   * :::
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Display name shown in the Azure portal. It must be unique within the
   * resource group, category, and source.
   * @default the logical ID
   */
  displayName?: string;
  /**
   * Workbook definition (the gallery template JSON). Pass a JSON string, or
   * an object that Alchemy serializes with `JSON.stringify`. Alchemy
   * compares it as canonical JSON, so key order and whitespace do not cause
   * an update.
   * @default `{"version":"Notebook/1.0","items":[]}`
   */
  serializedData?: string | Record<string, unknown>;
  /**
   * Gallery category, e.g. `workbook`, `sentinel`, or `TSG`.
   * @default "workbook"
   */
  category?: string;
  /**
   * ARM resource ID of the resource the workbook is linked to, e.g. a Log
   * Analytics workspace (`workspace.workspaceId`) or a resource group
   * (`group.resourceGroupId`). The workbook shows up in that resource's
   * Workbooks blade.
   *
   * :::caution
   * Changing it replaces the workbook.
   * :::
   * @default "azure monitor" (the Azure Monitor gallery)
   */
  sourceId?: string;
  /**
   * Workbook schema version, e.g. `Notebook/1.0`. Match the version in
   * `serializedData`.
   * @default not sent
   */
  version?: string;
  /**
   * Description of the workbook.
   * @default no description
   */
  description?: string;
  /**
   * ARM resource ID of a storage account for bring-your-own storage. Set
   * `identity` too.
   * @default Azure-managed storage
   */
  storageUri?: string;
  /**
   * Managed identity used for bring-your-own storage.
   * @default not sent (no identity)
   */
  identity?: WorkbookIdentity;
  /**
   * Workbook labels (`properties.tags`), shown in the gallery. They are not
   * the ARM `tags`.
   * @default []
   */
  labels?: string[];
  /**
   * User ARM tags. Alchemy ownership tags (`alchemy::stack`,
   * `alchemy::stage`, `alchemy::id`) are merged in automatically, and the
   * `hidden-title` tag Azure uses for the display name is kept in sync.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface Workbook extends Resource<
  "Azure.ApplicationInsights.Workbook",
  WorkbookProps,
  {
    /** ARM name (GUID) of the workbook. */
    workbookName: string;
    /** ARM resource ID of the workbook. */
    workbookId: string;
    /** Resource group that holds the workbook. */
    resourceGroup: string;
    /** Location of the workbook, e.g. `eastus`. */
    location: string;
    /** Display name shown in the Azure portal. */
    displayName: string;
    /** Gallery category of the workbook, e.g. `workbook`. */
    category: string;
    /** ARM resource ID of the linked resource, or `azure monitor`. */
    sourceId: string;
    /** Revision ID of the current workbook definition. */
    revision: string | undefined;
    /** Time (UTC, ISO 8601) the definition was last modified. */
    timeModified: string | undefined;
    /** ID of the user that owns the workbook. */
    userId: string | undefined;
    /** User ARM tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Monitor workbook (`Microsoft.Insights/workbooks`): an
 * interactive report of text, KQL queries, metrics, and charts, saved as a
 * shared resource that everyone with read access to the resource group
 * can open.
 *
 * :::caution[Changing `name`, `location`, `sourceId`, or `resourceGroup` replaces the workbook]
 * Alchemy creates a new workbook and deletes the old one. Its URL in the
 * portal changes. Change `displayName`, `serializedData`, `category`,
 * `labels`, or `tags` to update it in place.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/visualize/workbooks-overview
 *
 * ### Creating a Workbook
 * **Example:** Empty workbook in a resource group
 * ```typescript
 * const workbook = yield* Azure.ApplicationInsights.Workbook("overview", {
 *   displayName: "Service overview",
 * });
 * ```
 *
 * **Example:** Workbook with a text step
 * ```typescript
 * const workbook = yield* Azure.ApplicationInsights.Workbook("errors", {
 *   displayName: "Errors",
 *   labels: ["ops"],
 *   serializedData: {
 *     version: "Notebook/1.0",
 *     items: [
 *       {
 *         type: 1,
 *         content: { json: "## Errors in the last 24 hours" },
 *         name: "title",
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Workbooks over a Log Analytics Workspace
 * Set `sourceId` to the workspace's `workspaceId`. The workbook shows up in
 * the workspace's Workbooks blade, and its query steps run against the
 * workspace.
 *
 * **Example:** Workbook with a KQL query step over a workspace
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs");
 * const workbook = yield* Azure.ApplicationInsights.Workbook("logs", {
 *   displayName: "Workspace logs",
 *   sourceId: logs.workspaceId,
 *   serializedData: {
 *     version: "Notebook/1.0",
 *     items: [
 *       {
 *         type: 3,
 *         content: {
 *           version: "KqlItem/1.0",
 *           query: "Heartbeat | summarize count() by bin(TimeGenerated, 1h)",
 *           size: 0,
 *           queryType: 0,
 *           resourceType: "microsoft.operationalinsights/workspaces",
 *         },
 *         name: "heartbeats",
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Linking to a Resource Group
 * **Example:** Workbook in a resource group's Workbooks blade
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("ops", {
 *   location: "eastus",
 * });
 * const workbook = yield* Azure.ApplicationInsights.Workbook("report", {
 *   displayName: "Ops report",
 *   sourceId: group.resourceGroupId,
 * });
 * ```
 *
 * @resource
 */
export const Workbook = GroupedResource<Workbook>("Azure.ApplicationInsights.Workbook");

const DEFAULT_DATA = `{"version":"Notebook/1.0","items":[]}`;
const DEFAULT_SOURCE = "azure monitor";
const DEFAULT_CATEGORY = "workbook";
/** Gallery categories scanned by `list` (the list API requires one). */
const LIST_CATEGORIES = ["workbook", "TSG", "performance", "retention", "sentinel"] as const;

type ObservedWorkbook = applicationinsights.GetWorkbookResponse;

const getWorkbook = (subscriptionId: string, resourceGroupName: string, resourceName: string) =>
  orUndefinedIfNotFound(
    applicationinsights.GetWorkbook({
      subscriptionId,
      resourceGroupName,
      resourceName,
      canFetchContent: true,
    }),
  );

/** Canonical JSON so whitespace or key-order rewrites are not drift. */
const canonicalJson = (value: string | null | undefined): string => {
  if (value == null) return "";
  try {
    return JSON.stringify(sortKeys(JSON.parse(value)));
  } catch {
    return value;
  }
};

const sortKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
        )
      : value;

const serialize = (data: WorkbookProps["serializedData"]) =>
  data === undefined ? DEFAULT_DATA : typeof data === "string" ? data : JSON.stringify(data);

const sameIds = (a: string[], b: string[]) => {
  const norm = (ids: string[]) => ids.map((x) => x.toLowerCase()).sort();
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
};

/** Azure stamps the display name into a `hidden-title` ARM tag. */
const HIDDEN_TITLE = "hidden-title";

const workbookUserTags = (tags: Record<string, string | undefined> | undefined) => {
  const { [HIDDEN_TITLE]: _title, ...rest } = userTags(tags);
  return rest;
};

const toAttrs = (
  resourceGroup: string,
  name: string,
  workbook: ObservedWorkbook,
): Workbook["Attributes"] => ({
  workbookName: name,
  workbookId: workbook.id ?? "",
  resourceGroup,
  location: workbook.location,
  displayName: workbook.properties?.displayName ?? "",
  category: workbook.properties?.category ?? DEFAULT_CATEGORY,
  sourceId: workbook.properties?.sourceId ?? DEFAULT_SOURCE,
  revision: workbook.properties?.revision ?? undefined,
  timeModified: workbook.properties?.timeModified,
  userId: workbook.properties?.userId,
  tags: workbookUserTags(workbook.tags),
});

export const WorkbookProvider = () =>
  Provider.succeed(Workbook, {
    stables: ["workbookName", "workbookId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const seen = new Map<string, Workbook["Attributes"]>();
      for (const category of LIST_CATEGORIES) {
        const page = yield* collectAll(applicationinsights.ListWorkbookBySubscription, {
          subscriptionId,
          category,
        });
        for (const workbook of page.value ?? []) {
          const group = resourceGroupOf(workbook.id);
          if (
            hasAnyAlchemyTag(workbook.tags) &&
            group !== undefined &&
            workbook.name !== undefined &&
            workbook.id !== undefined
          ) {
            seen.set(workbook.id.toLowerCase(), toAttrs(group, workbook.name, workbook));
          }
        }
      }
      return [...seen.values()];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.workbookName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.replaceAll(" ", "").toLowerCase() !==
            output.location.replaceAll(" ", "").toLowerCase()) ||
        (news.sourceId ?? DEFAULT_SOURCE).toLowerCase() !== output.sourceId.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its resource group.
      if (resourceGroup === undefined) return undefined;
      const name = output?.workbookName ?? olds?.name ?? (yield* deterministicGuid(id, instanceId));
      const observed = yield* getWorkbook(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Insights");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.workbookName ?? (yield* deterministicGuid(id, instanceId));
      const location = news.location ?? output?.location ?? env.location;
      const displayName = news.displayName ?? id;
      const tags = {
        ...(yield* desiredTags(id, news.tags)),
        [HIDDEN_TITLE]: displayName,
      };
      const desired = {
        displayName,
        serializedData: serialize(news.serializedData),
        category: news.category ?? DEFAULT_CATEGORY,
        sourceId: news.sourceId ?? DEFAULT_SOURCE,
        version: news.version,
        description: news.description,
        storageUri: news.storageUri,
        labels: news.labels ?? [],
      };
      const identityIds = news.identity?.userAssignedIdentities ?? [];

      // Observe.
      const observed = yield* getWorkbook(subscriptionId, resourceGroup, name);

      // Ensure + sync. The PUT is a synchronous full-body upsert, so one
      // call creates a missing workbook or converges any observed drift.
      const props = observed?.properties;
      const observedIdentityIds = Object.keys(observed?.identity?.userAssignedIdentities ?? {});
      const drifted =
        observed === undefined ||
        props === undefined ||
        props.displayName !== desired.displayName ||
        canonicalJson(props.serializedData) !== canonicalJson(desired.serializedData) ||
        props.category !== desired.category ||
        (desired.version !== undefined && props.version !== desired.version) ||
        (props.description ?? undefined) !== desired.description ||
        (props.storageUri ?? undefined) !== desired.storageUri ||
        !sameIds(props.tags ?? [], desired.labels) ||
        (news.identity !== undefined &&
          ((observed.identity?.type ?? "None") !== news.identity.type ||
            !sameIds(observedIdentityIds, identityIds))) ||
        tagsDiffer(observed.tags, tags);

      if (observed !== undefined && !drifted) {
        return toAttrs(resourceGroup, name, observed);
      }
      const written = yield* applicationinsights.WorkbooksCreateOrUpdate({
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: name,
        sourceId: desired.sourceId,
        location: observed?.location ?? location,
        kind: "shared",
        tags,
        identity:
          news.identity === undefined
            ? undefined
            : {
                type: news.identity.type,
                userAssignedIdentities:
                  identityIds.length > 0
                    ? Object.fromEntries(identityIds.map((i) => [i, {}]))
                    : undefined,
              },
        properties: {
          displayName: desired.displayName,
          serializedData: desired.serializedData,
          category: desired.category,
          sourceId: desired.sourceId,
          version: desired.version,
          description: desired.description,
          storageUri: desired.storageUri,
          tags: desired.labels,
        },
      });
      return toAttrs(resourceGroup, name, written);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        applicationinsights.DeleteWorkbook({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          resourceName: output.workbookName,
        }),
      );
      yield* waitUntilGone(
        `workbook ${output.workbookName}`,
        getWorkbook(subscriptionId, output.resourceGroup, output.workbookName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
