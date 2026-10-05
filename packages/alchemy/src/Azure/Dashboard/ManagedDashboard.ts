import * as dashboard from "@distilled.cloud/azure/dashboard";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import { createGrafanaName } from "../Grafana/Workspace.ts";
import type { Providers } from "../Providers.ts";

export interface ManagedDashboardProps {
  /**
   * Resource group the dashboard is created in. Changing it replaces the
   * dashboard.
   */
  resourceGroup: string;
  /**
   * Dashboard name: letters, digits, and hyphens, starting with a letter.
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the dashboard.
   */
  name?: string;
  /**
   * Azure location of the dashboard. Changing it replaces the dashboard.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ManagedDashboard extends Resource<
  "Azure.Dashboard.ManagedDashboard",
  ManagedDashboardProps,
  {
    /** Name of the dashboard. */
    dashboardName: string;
    /** ARM resource ID of the dashboard. */
    dashboardId: string;
    /** Resource group that holds the dashboard. */
    resourceGroup: string;
    /** Location of the dashboard. */
    location: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Managed Dashboard (`Microsoft.Dashboard/dashboards`) — a
 * Grafana-based dashboard hosted by Azure without a Grafana workspace.
 * The ARM resource is a container: its panels are authored in the Azure
 * portal or the Grafana data plane.
 *
 * Managed dashboards are free.
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/visualize/visualize-use-grafana-dashboards
 *
 * ### Creating a Managed Dashboard
 * **Example:** Dashboard in a resource group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("observability");
 * const board = yield* Azure.Dashboard.ManagedDashboard("ops", {
 *   resourceGroup: group.resourceGroupName,
 *   tags: { team: "ops" },
 * });
 * ```
 *
 * @resource
 */
export const ManagedDashboard = Resource<ManagedDashboard>(
  "Azure.Dashboard.ManagedDashboard",
);

const getDashboard = (
  subscriptionId: string,
  resourceGroupName: string,
  dashboardName: string,
) =>
  orUndefinedIfNotFound(
    dashboard.GetDashboard({ subscriptionId, resourceGroupName, dashboardName }),
  );

const lower = (value: string | undefined) =>
  value?.toLowerCase().replaceAll(" ", "");

const toAttrs = (
  resourceGroup: string,
  name: string,
  board: dashboard.GetDashboardResponse | dashboard.ManagedDashboard,
): ManagedDashboard["Attributes"] => ({
  dashboardName: name,
  dashboardId: board.id ?? "",
  resourceGroup,
  location: board.location,
  tags: userTags(board.tags),
});

export const ManagedDashboardProvider = () =>
  Provider.succeed(ManagedDashboard, {
    stables: ["dashboardName", "dashboardId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        dashboard.ListDashboardBySubscription({ subscriptionId }),
      );
      if (page === undefined) return [];
      yield* requireSinglePage("ListDashboardBySubscription", page);
      return (page.value ?? []).flatMap((board) => {
        const group = resourceGroupOf(board.id);
        return hasAnyAlchemyTag(board.tags) &&
          group !== undefined &&
          board.name !== undefined
          ? [toAttrs(group, board.name, board)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.dashboardName)) ||
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
        output?.dashboardName ?? olds?.name ?? (yield* createGrafanaName(id));
      const observed = yield* getDashboard(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Dashboard");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.dashboardName ?? (yield* createGrafanaName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        dashboardName: name,
      };
      const get = getDashboard(subscriptionId, resourceGroup, name);
      const label = `managed dashboard ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* dashboard.CreateManagedDashboard({
          ...where,
          location,
          tags,
          properties: {},
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (board) => board.properties?.provisioningState,
      );

      // Sync tags (the only mutable aspect).
      if (tagsDiffer(observed.tags, tags)) {
        yield* dashboard.UpdateManagedDashboard({ ...where, tags });
        observed = yield* waitForProvisioned(
          label,
          get,
          (board) =>
            tagsDiffer(board.tags, tags)
              ? "Updating"
              : board.properties?.provisioningState,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        dashboard.DeleteManagedDashboard({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          dashboardName: output.dashboardName,
        }),
      );
      yield* waitUntilGone(
        `managed dashboard ${output.dashboardName}`,
        getDashboard(subscriptionId, output.resourceGroup, output.dashboardName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
