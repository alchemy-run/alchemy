import * as service from "@distilled.cloud/clickhouse-cloud/service";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import type { Providers } from "../Providers.ts";

export interface UpgradeWindowProps {
  /**
   * ID of a primary service, e.g. a `ClickHouseCloud.Service.Service`'s
   * `serviceId`; secondary services inherit their primary's window.
   * Changing it replaces the resource.
   */
  serviceId: string;
  /** Day the window starts, `0` (Sunday) to `6` (Saturday), UTC. */
  weekday: number;
  /** Hour the six-hour window starts, UTC: 0, 6, 12 or 18. */
  startHourUtc: 0 | 6 | 12 | 18;
}

export interface UpgradeWindowAttributes {
  /** Service ID. */
  serviceId: string;
  /** Organization ID. */
  organizationId: string;
  /** Day the window starts. */
  weekday: number;
  /** Hour the window starts, UTC. */
  startHourUtc: number;
  /** Length of the window in hours (always 6). */
  duration: number;
}

export type UpgradeWindow = Resource<
  "ClickHouseCloud.Service.UpgradeWindow",
  UpgradeWindowProps,
  UpgradeWindowAttributes,
  never,
  Providers
>;

/**
 * When ClickHouse may upgrade a service: a six-hour weekly window. Without
 * one, upgrades happen whenever the release channel delivers them.
 *
 * A primary service has at most one window; its secondary services follow
 * it. Destroying the resource removes the window. Needs the scheduled
 * upgrades feature (Enterprise tier).
 * @see https://clickhouse.com/docs/manage/updates
 *
 * ### Scheduling Upgrades
 * **Example:** Sunday nights, from 18:00 UTC
 * ```typescript
 * const analytics = yield* ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 * });
 * yield* ClickHouseCloud.Service.UpgradeWindow("SundayUpgrades", {
 *   serviceId: analytics.serviceId,
 *   weekday: 0,
 *   startHourUtc: 18,
 * });
 * ```
 *
 * :::caution
 * Changing `serviceId` replaces the resource: the old service loses its
 * window.
 * :::
 *
 * @resource
 * @product Service
 */
export const UpgradeWindow = Resource<UpgradeWindow>("ClickHouseCloud.Service.UpgradeWindow");

const toAttributes = (
  organizationId: string,
  serviceId: string,
  window: service.UpgradeWindow,
): UpgradeWindowAttributes => ({
  serviceId,
  organizationId,
  weekday: window.weekday,
  startHourUtc: window.startHourUtc,
  duration: window.duration,
});

const getWindow = (organizationId: string, serviceId: string) =>
  service
    .getUpgradeWindow({ organizationId, serviceId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const UpgradeWindowProvider = () =>
  Provider.effect(
    UpgradeWindow,
    Effect.succeed({
      stables: ["serviceId", "organizationId"],
      nuke: { singleton: true, dependsOn: ["ClickHouseCloud.Service.Service"] },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news) || olds === undefined) return undefined;
        if (news.serviceId !== olds.serviceId) return { action: "replace" } as const;
        return undefined;
      }),
      read: Effect.fn(function* ({ olds, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const serviceId = output?.serviceId ?? olds.serviceId;
        const window = yield* getWindow(organizationId, serviceId);
        return window === undefined ? undefined : toAttributes(organizationId, serviceId, window);
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { serviceId } = news;
        // Observe
        const observed = yield* getWindow(organizationId, serviceId);
        if (
          observed !== undefined &&
          observed.weekday === news.weekday &&
          observed.startHourUtc === news.startHourUtc
        ) {
          return toAttributes(organizationId, serviceId, observed);
        }
        // Ensure + sync: a PUT that creates or replaces the window.
        const updated = yield* service.updateUpgradeWindow({
          organizationId,
          serviceId,
          weekday: news.weekday,
          startHourUtc: news.startHourUtc,
        });
        return toAttributes(organizationId, serviceId, updated);
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* service
          .deleteUpgradeWindow({
            organizationId: output.organizationId,
            serviceId: output.serviceId,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    }),
  );
