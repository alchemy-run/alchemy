import * as portal from "@distilled.cloud/azure/portal";
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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/** Tag the Azure portal reads as a dashboard's display title. */
const TITLE_TAG = "hidden-title";

/** Position and size of a part on the dashboard grid. */
export interface DashboardPartPosition {
  /** Column of the part's top-left corner. */
  x: number;
  /** Row of the part's top-left corner. */
  y: number;
  /** Number of grid rows the part spans. */
  rowSpan: number;
  /** Number of grid columns the part spans. */
  colSpan: number;
  /** Free-form position metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * Metadata of a dashboard part. `type` selects the part kind, e.g.
 * `Extension/HubsExtension/PartType/MarkdownPart`; the remaining fields
 * (`inputs`, `settings`, ...) are specific to that kind.
 */
export interface DashboardPartMetadata {
  /** Part kind, e.g. `Extension/HubsExtension/PartType/MarkdownPart`. */
  type: string;
  /** Kind-specific fields such as `inputs` and `settings`. */
  [key: string]: unknown;
}

/** A tile on a dashboard lens. */
export interface DashboardPart {
  /** Where the part sits on the grid. */
  position: DashboardPartPosition;
  /** What the part renders. */
  metadata?: DashboardPartMetadata;
}

/** A dashboard lens: an ordered group of parts. */
export interface DashboardLens {
  /** Lens order, starting at 0. */
  order: number;
  /** Parts shown on the lens. */
  parts: DashboardPart[];
  /** Free-form lens metadata. */
  metadata?: Record<string, unknown>;
}

export interface DashboardProps {
  /**
   * Resource group the dashboard is created in. Changing it replaces the
   * dashboard.
   */
  resourceGroup: string;
  /**
   * ARM name of the dashboard (letters, digits, `-` and `_`). If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing it
   * replaces the dashboard.
   */
  name?: string;
  /**
   * Azure location of the dashboard. Changing it replaces the dashboard.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Display title shown in the Azure portal, stored in the `hidden-title`
   * tag.
   * @default the dashboard name
   */
  title?: string;
  /**
   * Dashboard lenses and their parts.
   * @default []
   */
  lenses?: DashboardLens[];
  /**
   * Dashboard-level metadata, e.g. the shared time range and filters
   * (`{ model: { timeRange: ..., filterLocale: ..., filters: ... } }`).
   */
  metadata?: Record<string, unknown>;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) and the `hidden-title` tag are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Dashboard extends Resource<
  "Azure.Portal.Dashboard",
  DashboardProps,
  {
    /** ARM name of the dashboard. */
    dashboardName: string;
    /** Resource group that holds the dashboard. */
    resourceGroup: string;
    /** ARM resource ID of the dashboard. */
    dashboardId: string;
    /** Location of the dashboard. */
    location: string;
    /** Display title (the `hidden-title` tag), if set. */
    title: string | undefined;
    /** Link that opens the dashboard in the Azure portal. */
    portalUrl: string;
    /** User tags (Alchemy ownership tags and `hidden-title` stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A shared Azure portal dashboard — a grid of tiles (Markdown, metrics
 * charts, resource views) stored as an ARM resource so a team can version
 * it next to the infrastructure it shows.
 *
 * @see https://learn.microsoft.com/azure/azure-portal/azure-portal-dashboards-structure
 *
 * ### Creating a Dashboard
 * **Example:** Dashboard with a Markdown tile
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("ops");
 * const dashboard = yield* Azure.Portal.Dashboard("overview", {
 *   resourceGroup: group.resourceGroupName,
 *   title: "Service overview",
 *   lenses: [
 *     {
 *       order: 0,
 *       parts: [
 *         {
 *           position: { x: 0, y: 0, colSpan: 6, rowSpan: 4 },
 *           metadata: {
 *             type: "Extension/HubsExtension/PartType/MarkdownPart",
 *             inputs: [],
 *             settings: {
 *               content: {
 *                 content: "# Runbook\nSee the on-call wiki.",
 *                 title: "Runbook",
 *                 subtitle: "",
 *                 markdownSource: 1,
 *               },
 *             },
 *           },
 *         },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * ### Sharing the Time Range
 * **Example:** Dashboard-level metadata
 * ```typescript
 * const dashboard = yield* Azure.Portal.Dashboard("metrics", {
 *   resourceGroup: group.resourceGroupName,
 *   lenses: [],
 *   metadata: {
 *     model: {
 *       timeRange: {
 *         value: { relative: { duration: 24, timeUnit: 1 } },
 *         type: "MsPortalFx.Composition.Configuration.ValueTypes.TimeRange",
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Dashboard = Resource<Dashboard>("Azure.Portal.Dashboard");

type ObservedDashboard = portal.GetDashboardResponse;

const getDashboard = (
  subscriptionId: string,
  resourceGroupName: string,
  dashboardName: string,
) =>
  orUndefinedIfNotFound(
    portal.GetDashboard({ subscriptionId, resourceGroupName, dashboardName }),
  );

/** Canonical JSON (sorted keys, `undefined` dropped) for deep comparison. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  ) ?? "null";

const toAttrs = (
  resourceGroup: string,
  name: string,
  dashboard: ObservedDashboard,
): Dashboard["Attributes"] => {
  const { [TITLE_TAG]: title, ...tags } = userTags(dashboard.tags);
  const dashboardId = dashboard.id ?? "";
  return {
    dashboardName: name,
    resourceGroup,
    dashboardId,
    location: dashboard.location,
    title,
    portalUrl: `https://portal.azure.com/#@/dashboard/arm${dashboardId}`,
    tags,
  };
};

export const DashboardProvider = () =>
  Provider.succeed(Dashboard, {
    stables: ["dashboardName", "resourceGroup", "dashboardId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* portal
        .ListDashboardBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListDashboardBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((dashboard) => {
        const group = resourceGroupOf(dashboard.id);
        return hasAnyAlchemyTag(dashboard.tags) &&
          group !== undefined &&
          dashboard.name !== undefined
          ? [toAttrs(group, dashboard.name, dashboard)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.dashboardName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its resource group.
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.dashboardName ??
        olds?.name ??
        (yield* createPhysicalName({ id, maxLength: 64 }));
      const observed = yield* getDashboard(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Portal");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.dashboardName ??
        (yield* createPhysicalName({ id, maxLength: 64 }));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, {
        ...news.tags,
        ...(news.title !== undefined ? { [TITLE_TAG]: news.title } : {}),
      });
      const properties = {
        lenses: news.lenses ?? [],
        ...(news.metadata !== undefined ? { metadata: news.metadata } : {}),
      };

      // Observe.
      let observed = yield* getDashboard(subscriptionId, resourceGroup, name);

      // Ensure + sync: the PUT is a synchronous upsert of the whole
      // dashboard, and lenses, metadata, and tags are its only mutable
      // aspects, so one PUT covers any observed delta.
      const propertiesDiffer =
        observed === undefined ||
        canonical(observed.properties?.lenses ?? []) !==
          canonical(properties.lenses) ||
        canonical(observed.properties?.metadata ?? null) !==
          canonical(properties.metadata ?? null);
      if (
        observed === undefined ||
        propertiesDiffer ||
        tagsDiffer(observed.tags, tags)
      ) {
        observed = yield* portal.DashboardsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          dashboardName: name,
          location: observed?.location ?? location,
          tags,
          properties,
        });
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        portal.DeleteDashboard({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          dashboardName: output.dashboardName,
        }),
      );
      yield* waitUntilGone(
        `dashboard ${output.dashboardName}`,
        getDashboard(subscriptionId, output.resourceGroup, output.dashboardName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
