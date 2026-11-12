import * as service from "@distilled.cloud/clickhouse-cloud/service";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { requireResult } from "../Errors.ts";
import { getLiveService, isRunning, waitForService } from "../internal/Wait.ts";
import type { Providers } from "../Providers.ts";

export interface ClickHouseSettingProps {
  /** ID of the service, e.g. a `ClickHouseCloud.Service.Service`'s `serviceId`. Changing it replaces the resource. */
  serviceId: string;
  /**
   * Name of the setting, e.g. `max_threads`, or a server setting under
   * `spec.extraConfig.server.*`. Changing it replaces the resource.
   */
  name: string;
  /** Value of the setting, in its native type. */
  value: string | number;
}

export interface ClickHouseSettingAttributes {
  /** Service ID. */
  serviceId: string;
  /** Organization ID. */
  organizationId: string;
  /** Setting name. */
  name: string;
  /** Current value. */
  value: string | number | undefined;
  /** Warnings ClickHouse gave for the last change, e.g. that it restarts the service. */
  warnings: string[];
}

export type ClickHouseSetting = Resource<
  "ClickHouseCloud.Service.ClickHouseSetting",
  ClickHouseSettingProps,
  ClickHouseSettingAttributes,
  never,
  Providers
>;

/**
 * One ClickHouse setting of a service, set through the Cloud API instead of
 * SQL: a user-level default such as `max_threads`, or a server setting under
 * `spec.extraConfig.server.*`. The endpoint is in beta.
 *
 * Server settings roll out with a restart of the service's replicas; deploy
 * waits until the service is running again. Destroying the resource resets
 * the setting to ClickHouse's default. The settings API must be enabled for
 * the organization by ClickHouse support.
 * @see https://clickhouse.com/docs/operations/settings/settings
 *
 * ### Setting a Value
 * **Example:** Cap query threads
 * ```typescript
 * const analytics = yield* ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 * });
 * yield* ClickHouseCloud.Service.ClickHouseSetting("MaxThreads", {
 *   serviceId: analytics.serviceId,
 *   name: "max_threads",
 *   value: 8,
 * });
 * ```
 *
 * :::caution
 * Changing `serviceId` or `name` replaces the resource: the old setting is
 * reset to its default. Server settings restart the service.
 * :::
 *
 * Uses ClickHouse Cloud API endpoints marked Beta: `deleteServiceClickHouseSetting`, `listServiceClickHouseSettings`, `updateServiceClickHouseSettings`.
 *
 * @resource
 * @product Service
 */
export const ClickHouseSetting = Resource<ClickHouseSetting>(
  "ClickHouseCloud.Service.ClickHouseSetting",
);

/** Whether the setting is explicitly set: only those are listed. */
const getSetting = (organizationId: string, serviceId: string, name: string) =>
  service.listServiceClickHouseSettings({ organizationId, serviceId }).pipe(
    Effect.flatMap(requireResult("listServiceClickHouseSettings")),
    Effect.map((list) => (list.settings ?? []).find((s) => s.name === name)),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const ClickHouseSettingProvider = () =>
  Provider.effect(
    ClickHouseSetting,
    Effect.succeed({
      stables: ["serviceId", "organizationId", "name"],
      nuke: { singleton: true, dependsOn: ["ClickHouseCloud.Service.Service"] },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news) || olds === undefined) return undefined;
        if (news.serviceId !== olds.serviceId || news.name !== olds.name) {
          return { action: "replace" } as const;
        }
        return undefined;
      }),
      read: Effect.fn(function* ({ olds, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const serviceId = output?.serviceId ?? olds.serviceId;
        const name = output?.name ?? olds.name;
        const setting = yield* getSetting(organizationId, serviceId, name);
        if (setting === undefined) return undefined;
        return {
          serviceId,
          organizationId,
          name,
          value: setting.value,
          warnings: output?.warnings ?? [],
        };
      }),
      reconcile: Effect.fn(function* ({ news, output, session }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { serviceId, name, value } = news;
        // Observe
        const observed = yield* getSetting(organizationId, serviceId, name);
        if (observed !== undefined && String(observed.value) === String(value)) {
          return {
            serviceId,
            organizationId,
            name,
            value: observed.value,
            warnings: output?.warnings ?? [],
          };
        }
        // Ensure + sync
        const updated = yield* service
          .updateServiceClickHouseSettings({
            organizationId,
            serviceId,
            settings: { [name]: value },
          })
          .pipe(Effect.flatMap(requireResult("updateServiceClickHouseSettings")));
        // Server settings roll out with a restart.
        const live = yield* getLiveService(organizationId, serviceId);
        if (live !== undefined && !isRunning(live.state) && live.state !== "stopped") {
          yield* waitForService({
            organizationId,
            serviceId,
            waitingFor: "running",
            done: (s) => s !== undefined && (isRunning(s.state) || s.state === "stopped"),
            session,
          });
        }
        return {
          serviceId,
          organizationId,
          name,
          value: updated.settings?.[name] ?? value,
          warnings: (updated.warnings ?? []).flatMap((w) =>
            w.message === undefined ? [] : [w.message],
          ),
        };
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* service
          .deleteServiceClickHouseSetting({
            organizationId: output.organizationId,
            serviceId: output.serviceId,
            settingName: output.name,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    }),
  );
