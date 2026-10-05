import * as applicationinsights from "@distilled.cloud/azure/applicationinsights";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
  waitUntilGone,
} from "../Arm.ts";
import { deterministicGuid } from "../Authorization/Ownership.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/** Managed identity used by a workbook to reach bring-your-own storage. */
export interface WorkbookIdentity {
  /** Identity type. Workbooks only accept user-assigned identities. */
  type: "UserAssigned" | "None";
  /**
   * ARM resource IDs of the user-assigned identities, e.g.
   * `identity.identityId` of an `Azure.ManagedIdentity.UserAssignedIdentity`.
   */
  userAssignedIdentities?: string[];
}

export interface WorkbookProps {
  /**
   * Resource group the workbook is created in. Changing it replaces the
   * workbook.
   */
  resourceGroup: string;
  /**
   * ARM name of the workbook. Azure requires a GUID. If omitted, a
   * deterministic GUID is derived from the stack, stage, logical ID and
   * instance ID. Changing it replaces the workbook.
   */
  name?: string;
  /**
   * Azure location of the workbook. Changing it replaces the workbook.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Display name shown in the Azure portal. Must be unique within the
   * resource group, category and source.
   * @default the logical ID
   */
  displayName?: string;
  /**
   * Workbook definition (the gallery template JSON). Pass a JSON string or
   * an object, which is serialized with `JSON.stringify`.
   * @default `{"version":"Notebook/1.0","items":[]}`
   */
  serializedData?: string | Record<string, unknown>;
  /**
   * Gallery category, e.g. `workbook`, `sentinel`, `TSG`.
   * @default "workbook"
   */
  category?: string;
  /**
   * ARM resource ID of the resource the workbook is linked to. Changing it
   * replaces the workbook.
   * @default "azure monitor"
   */
  sourceId?: string;
  /**
   * Workbook schema version, e.g. `Notebook/1.0`. Should match the version
   * in `serializedData`.
   */
  version?: string;
  /** Description of the workbook. */
  description?: string;
  /**
   * ARM resource ID of a storage account for bring-your-own storage.
   * Requires `identity`.
   */
  storageUri?: string;
  /** Managed identity used for bring-your-own storage. */
  identity?: WorkbookIdentity;
  /**
   * Workbook labels (`properties.tags`), shown in the gallery. Distinct
   * from the ARM `tags`.
   */
  labels?: string[];
  /**
   * User ARM tags. Alchemy ownership tags (`alchemy::stack`,
   * `alchemy::stage`, `alchemy::id`) are merged in automatically, and the
   * `hidden-title` tag Azure uses for the display name is kept in sync.
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
    /** Location of the workbook. */
    location: string;
    /** Display name shown in the Azure portal. */
    displayName: string;
    /** Gallery category of the workbook. */
    category: string;
    /** Resource the workbook is linked to. */
    sourceId: string;
    /** Revision ID of the current workbook definition. */
    revision: string | undefined;
    /** Time (UTC) the definition was last modified. */
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
 * An Azure Monitor workbook — an interactive report of queries,
 * metrics and visualizations, stored as a shared ARM resource
 * (`Microsoft.Insights/workbooks`).
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/visualize/workbooks-overview
 *
 * ### Creating a Workbook
 * **Example:** Empty workbook in a resource group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("monitoring");
 * const workbook = yield* Azure.ApplicationInsights.Workbook("overview", {
 *   resourceGroup: group.resourceGroupName,
 *   displayName: "Service overview",
 * });
 * ```
 *
 * **Example:** Workbook with a query step
 * ```typescript
 * const workbook = yield* Azure.ApplicationInsights.Workbook("errors", {
 *   resourceGroup: group.resourceGroupName,
 *   displayName: "Errors",
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
 * ### Linking to a Resource
 * **Example:** Workbook linked to a Log Analytics workspace
 * ```typescript
 * const workbook = yield* Azure.ApplicationInsights.Workbook("logs", {
 *   resourceGroup: group.resourceGroupName,
 *   displayName: "Workspace logs",
 *   sourceId: workspace.workspaceId,
 * });
 * ```
 *
 * @resource
 */
export const Workbook = Resource<Workbook>(
  "Azure.ApplicationInsights.Workbook",
);

const DEFAULT_DATA = `{"version":"Notebook/1.0","items":[]}`;
const DEFAULT_SOURCE = "azure monitor";
const DEFAULT_CATEGORY = "workbook";
/** Gallery categories scanned by `list` (the list API requires one). */
const LIST_CATEGORIES = [
  "workbook",
  "TSG",
  "performance",
  "retention",
  "sentinel",
] as const;

type ObservedWorkbook = applicationinsights.GetWorkbookResponse;

const getWorkbook = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
) =>
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
  data === undefined
    ? DEFAULT_DATA
    : typeof data === "string"
      ? data
      : JSON.stringify(data);

const sameIds = (a: string[], b: string[]) => {
  const norm = (ids: string[]) => ids.map((x) => x.toLowerCase()).sort();
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
};

/** Azure stamps the display name into a `hidden-title` ARM tag. */
const HIDDEN_TITLE = "hidden-title";

const workbookUserTags = (
  tags: Record<string, string | undefined> | undefined,
) => {
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
        const page = yield* applicationinsights
          .ListWorkbookBySubscription({ subscriptionId, category })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListWorkbookBySubscription", page),
            ),
          );
        for (const workbook of page.value ?? []) {
          const group = resourceGroupOf(workbook.id);
          if (
            hasAnyAlchemyTag(workbook.tags) &&
            group !== undefined &&
            workbook.name !== undefined &&
            workbook.id !== undefined
          ) {
            seen.set(
              workbook.id.toLowerCase(),
              toAttrs(group, workbook.name, workbook),
            );
          }
        }
      }
      return [...seen.values()];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.workbookName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.replaceAll(" ", "").toLowerCase() !==
            output.location.replaceAll(" ", "").toLowerCase()) ||
        (news.sourceId ?? DEFAULT_SOURCE).toLowerCase() !==
          output.sourceId.toLowerCase()
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
      const name =
        output?.workbookName ??
        olds?.name ??
        (yield* deterministicGuid(id, instanceId));
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
      const name =
        news.name ??
        output?.workbookName ??
        (yield* deterministicGuid(id, instanceId));
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
      const observedIdentityIds = Object.keys(
        observed?.identity?.userAssignedIdentities ?? {},
      );
      const drifted =
        observed === undefined ||
        props === undefined ||
        props.displayName !== desired.displayName ||
        canonicalJson(props.serializedData) !==
          canonicalJson(desired.serializedData) ||
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
