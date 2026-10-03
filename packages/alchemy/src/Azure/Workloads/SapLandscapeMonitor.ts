import * as workloads from "@distilled.cloud/azure/workloads";
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
import { lower, monitorOwnedByStage } from "./Common.ts";

/** A named group of SAP system IDs on the landscape dashboard. */
export interface SapLandscapeSidMapping {
  /** Name of the group, e.g. `Production`. */
  name: string;
  /** SAP system IDs in the group. */
  topSid: string[];
}

/** Health thresholds for one top metric on the landscape dashboard. */
export interface SapLandscapeMetricThreshold {
  /** Name of the metric, e.g. `Instance Availability`. */
  name: string;
  /** Threshold value for green. */
  green: number;
  /** Threshold value for yellow. */
  yellow: number;
  /** Threshold value for red. */
  red: number;
}

export interface SapLandscapeMonitorProps {
  /** Resource group of the monitor. Changing it replaces the resource. */
  resourceGroup: string;
  /** Name of the parent monitor. Changing it replaces the resource. */
  monitor: string;
  /** SID groupings by landscape (e.g. `Production`, `Non-Production`). */
  landscape?: SapLandscapeSidMapping[];
  /** SID groupings by SAP application (e.g. `ERP`, `BW`). */
  sapApplication?: SapLandscapeSidMapping[];
  /** Thresholds for the top-metrics health view. */
  topMetricsThresholds?: SapLandscapeMetricThreshold[];
}

export interface SapLandscapeMonitor extends Resource<
  "Azure.Workloads.SapLandscapeMonitor",
  SapLandscapeMonitorProps,
  {
    /** ARM resource ID of the landscape monitor configuration. */
    sapLandscapeMonitorId: string;
    /** Resource group of the monitor. */
    resourceGroup: string;
    /** Name of the parent monitor. */
    monitor: string;
    /** SID groupings by landscape. */
    landscape: SapLandscapeSidMapping[];
    /** SID groupings by SAP application. */
    sapApplication: SapLandscapeSidMapping[];
    /** Thresholds for the top-metrics health view. */
    topMetricsThresholds: SapLandscapeMetricThreshold[];
    /** Provisioning state of the configuration. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The SAP landscape monitor dashboard configuration of an Azure Monitor
 * for SAP solutions {@link Monitor} — a singleton (`default`) per monitor
 * that groups SAP system IDs by landscape and application and sets the
 * health thresholds of the top-metrics view.
 *
 * @see https://learn.microsoft.com/rest/api/workloads/sap-landscape-monitor
 *
 * ### Configuring the Dashboard
 * **Example:** Group systems and set thresholds
 * ```typescript
 * yield* Azure.Workloads.SapLandscapeMonitor("landscape", {
 *   resourceGroup: group.resourceGroupName,
 *   monitor: monitor.monitorName,
 *   landscape: [{ name: "Production", topSid: ["S4P"] }],
 *   sapApplication: [{ name: "ERP", topSid: ["S4P", "S4Q"] }],
 *   topMetricsThresholds: [
 *     { name: "Instance Availability", green: 90, yellow: 75, red: 50 },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const SapLandscapeMonitor = Resource<SapLandscapeMonitor>(
  "Azure.Workloads.SapLandscapeMonitor",
);

type Observed = workloads.GetSapLandscapeMonitorResponse;

const getLandscape = (
  subscriptionId: string,
  resourceGroupName: string,
  monitorName: string,
) =>
  orUndefinedIfNotFound(
    workloads.GetSapLandscapeMonitor({
      subscriptionId,
      resourceGroupName,
      monitorName,
    }),
  );

const mappings = (
  value: readonly { name?: string; topSid?: readonly string[] }[] | undefined,
): SapLandscapeSidMapping[] =>
  (value ?? []).map((m) => ({ name: m.name ?? "", topSid: [...(m.topSid ?? [])] }));

const thresholds = (
  value:
    | readonly {
        name?: string;
        green?: number;
        yellow?: number;
        red?: number;
      }[]
    | undefined,
): SapLandscapeMetricThreshold[] =>
  (value ?? []).map((t) => ({
    name: t.name ?? "",
    green: t.green ?? 0,
    yellow: t.yellow ?? 0,
    red: t.red ?? 0,
  }));

const toAttrs = (
  resourceGroup: string,
  monitor: string,
  observed: Observed,
): SapLandscapeMonitor["Attributes"] => ({
  sapLandscapeMonitorId: observed.id ?? "",
  resourceGroup,
  monitor,
  landscape: mappings(observed.properties?.grouping?.landscape),
  sapApplication: mappings(observed.properties?.grouping?.sapApplication),
  topMetricsThresholds: thresholds(observed.properties?.topMetricsThresholds),
  provisioningState: observed.properties?.provisioningState,
});

export const SapLandscapeMonitorProvider = () =>
  Provider.succeed(SapLandscapeMonitor, {
    stables: ["sapLandscapeMonitorId", "resourceGroup", "monitor"],

    // The singleton vanishes with its monitor.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.monitor) !== lower(output.monitor)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const monitor = output?.monitor ?? olds?.monitor;
      if (resourceGroup === undefined || monitor === undefined) {
        return undefined;
      }
      const observed = yield* getLandscape(
        subscriptionId,
        resourceGroup,
        monitor,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, monitor, observed);
      return (yield* monitorOwnedByStage(subscriptionId, resourceGroup, monitor))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Workloads");
      const { resourceGroup, monitor } = news;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        monitorName: monitor,
      };
      const desired = {
        landscape: news.landscape ?? [],
        sapApplication: news.sapApplication ?? [],
        topMetricsThresholds: news.topMetricsThresholds ?? [],
      };
      const properties = {
        grouping: {
          landscape: desired.landscape,
          sapApplication: desired.sapApplication,
        },
        topMetricsThresholds: desired.topMetricsThresholds,
      };
      const get = getLandscape(subscriptionId, resourceGroup, monitor);

      // Observe.
      let observed = yield* get;

      // Ensure, then sync the configuration against what Azure reports.
      if (observed === undefined) {
        yield* workloads.CreateSapLandscapeMonitor({ ...where, properties });
      } else {
        const current = toAttrs(resourceGroup, monitor, observed);
        if (
          JSON.stringify([
            current.landscape,
            current.sapApplication,
            current.topMetricsThresholds,
          ]) !==
          JSON.stringify([
            mappings(desired.landscape),
            mappings(desired.sapApplication),
            thresholds(desired.topMetricsThresholds),
          ])
        ) {
          yield* workloads.UpdateSapLandscapeMonitor({ ...where, properties });
        }
      }
      observed = yield* waitForProvisioned(
        `SAP landscape monitor of ${monitor}`,
        get,
        // `Created` is this resource's terminal success state.
        (value) =>
          value.properties?.provisioningState === "Created"
            ? "Succeeded"
            : value.properties?.provisioningState,
        { interval: "3 seconds", times: 40 },
      );

      return toAttrs(resourceGroup, monitor, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        workloads.DeleteSapLandscapeMonitor({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          monitorName: output.monitor,
        }),
      );
      yield* waitUntilGone(
        `SAP landscape monitor of ${output.monitor}`,
        getLandscape(subscriptionId, output.resourceGroup, output.monitor),
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Workloads.Monitor"],
    },
  });
