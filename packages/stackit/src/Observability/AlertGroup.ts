import * as observability from "@distilled.cloud/stackit/observability";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import type { InstanceScope } from "./internal.ts";
import {
  makeAlertGroupLifecycle,
  type AlertGroupApi,
  type AlertGroupRule,
} from "./internal/alertGroups.ts";

export type { AlertGroupRule } from "./internal/alertGroups.ts";

export interface AlertGroupProps {
  /** Id of the instance that evaluates the group. Changing it replaces the group. */
  instanceId: string;
  /**
   * Name of the group, 1 to 200 of `a-zA-Z0-9-`. Changing it replaces the group.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /**
   * How often the rules are evaluated, at least 60 seconds. Updates in place.
   *
   * @default "60s"
   */
  interval?: string;
  /** The PromQL rules of the group. Updates in place. */
  rules: AlertGroupRule[];
  /** Project that owns the instance. Changing it replaces the group. @default the profile's project */
  projectId?: string;
}

export interface AlertGroupAttributes {
  /** Name of the group. */
  name: string;
  /** Id of the instance that evaluates the group. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** How often the rules are evaluated. */
  interval: string | undefined;
  /** The rules of the group. */
  rules: AlertGroupRule[];
}

export type AlertGroup = Resource<
  "Stackit.Observability.AlertGroup",
  AlertGroupProps,
  AlertGroupAttributes,
  never,
  Providers
>;

/**
 * A group of Prometheus alerting and recording rules on a
 * `Stackit.Observability.Instance`. `rules` is the whole group: per-rule changes at
 * runtime are the bindings' job.
 *
 * The name is the group's identity: changing it, or the instance, replaces the group,
 * and `rules` and `interval` update in place. Groups have no labels: a group found by
 * a name you chose, without state, is reported as unowned and only taken over with
 * `--adopt`.
 *
 * See [STACKIT's Observability docs](https://docs.stackit.cloud/products/logging-and-monitoring/observability/).
 *
 * :::caution[Changing `instanceId`, `name` or `projectId` replaces the Group]
 * The name is the group's identity. The new group is created and the old one is
 * deleted. `rules` and `interval` update in place.
 * :::
 *
 * ### Alerting
 * **Example:** Fire when a job stops answering
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const group = yield* Stackit.Observability.AlertGroup("Availability", {
 *   instanceId: instance.instanceId,
 *   rules: [
 *     {
 *       alert: "JobDown",
 *       expr: "up == 0",
 *       for: "5m",
 *       labels: { severity: "critical" },
 *       annotations: { summary: "A scrape target is down" },
 *     },
 *   ],
 * });
 * ```
 *
 * ### Recording
 * **Example:** Precompute an expensive query
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const group = yield* Stackit.Observability.AlertGroup("Rollups", {
 *   instanceId: instance.instanceId,
 *   interval: "5m",
 *   rules: [
 *     {
 *       record: "job:http_requests:rate5m",
 *       expr: "sum by (job) (rate(http_requests_total[5m]))",
 *     },
 *   ],
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Renaming a group
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // A new group is created and the old one deleted. Alerts firing from the old group
 * // resolve, and those of the new one start from pending.
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const group = yield* Stackit.Observability.AlertGroup("Availability", {
 *   instanceId: instance.instanceId,
 *   name: "availability-v2",
 *   rules: [{ alert: "JobDown", expr: "up == 0" }],
 * });
 * ```
 *
 * @resource
 * @product STACKIT Observability
 * @category Observability
 */
export const AlertGroup = Resource<AlertGroup>("Stackit.Observability.AlertGroup");

const api: AlertGroupApi<
  | observability.GetAlertgroupError
  | observability.ListAlertgroupsError
  | observability.CreateAlertgroupsError
  | observability.UpdateAlertgroupError
  | observability.DeleteAlertgroupError,
  observability.StackitOpContext
> = {
  get: (scope: InstanceScope, groupName) =>
    observability.getAlertgroup({ ...scope, groupName }).pipe(
      Effect.map(({ data }) => data),
      Effect.catchTag("NotFound", () => Effect.undefined),
    ),
  list: (scope) => observability.listAlertgroups(scope).pipe(Effect.map(({ data }) => data)),
  create: (scope, name, interval, rules) =>
    observability.createAlertgroups({ ...scope, name, interval, rules }),
  update: (scope, groupName, interval, rules) =>
    observability.updateAlertgroup({ ...scope, groupName, interval, rules }),
  remove: (scope, groupName) =>
    observability.deleteAlertgroup({ ...scope, groupName }).pipe(
      Effect.asVoid,
      Effect.catchTag("NotFound", () => Effect.void),
    ),
};

export const AlertGroupProvider = () => {
  const lifecycle = makeAlertGroupLifecycle({
    label: "STACKIT Observability alert group",
    api,
  });

  return Provider.succeed(AlertGroup, {
    stables: ["name", "instanceId", "projectId"],
    nuke: { dependsOn: ["Stackit.Observability.Instance"] },
    list: lifecycle.list,

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      return yield* lifecycle.diff(news, output);
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      return yield* lifecycle.read(id, olds, output, previous);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      return yield* lifecycle.reconcile(id, news, output);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* lifecycle.delete(output);
    }),
  });
};
