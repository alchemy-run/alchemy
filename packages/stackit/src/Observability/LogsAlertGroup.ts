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

export interface LogsAlertGroupProps {
  /**
   * Id of the instance that evaluates the group. It needs a plan with logs. Changing it
   * replaces the group.
   */
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
  /** The LogQL rules of the group. Updates in place. */
  rules: AlertGroupRule[];
  /** Project that owns the instance. Changing it replaces the group. @default the profile's project */
  projectId?: string;
}

export interface LogsAlertGroupAttributes {
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

export type LogsAlertGroup = Resource<
  "Stackit.Observability.LogsAlertGroup",
  LogsAlertGroupProps,
  LogsAlertGroupAttributes,
  never,
  Providers
>;

/**
 * A group of Loki alerting and recording rules, in LogQL, on a
 * `Stackit.Observability.Instance` whose plan has logs: an `Observability-*` plan, not
 * an `Observability-Monitoring-*` one.
 *
 * The name is the group's identity: changing it, or the instance, replaces the group,
 * and `rules` and `interval` update in place. Groups have no labels: a group found by
 * a name you chose, without state, is reported as unowned and only taken over with
 * `--adopt`.
 *
 * ### Alerting on Logs
 * **Example:** Fire on a burst of errors
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Telemetry", {
 *   plan: "Observability-Starter-EU01",
 * });
 * const group = yield* Stackit.Observability.LogsAlertGroup("Errors", {
 *   instanceId: instance.instanceId,
 *   rules: [
 *     {
 *       alert: "ErrorBurst",
 *       expr: 'sum(rate({app="api"} |= "error" [5m])) > 1',
 *       for: "5m",
 *       labels: { severity: "warning" },
 *       annotations: { summary: "The API is logging many errors" },
 *     },
 *   ],
 * });
 * ```
 *
 * ### Recording from Logs
 * **Example:** Turn a log query into a metric
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Telemetry", {
 *   plan: "Observability-Starter-EU01",
 * });
 * const group = yield* Stackit.Observability.LogsAlertGroup("LogMetrics", {
 *   instanceId: instance.instanceId,
 *   rules: [
 *     {
 *       record: "app:log_lines:rate5m",
 *       expr: 'sum by (app) (rate({app=~".+"} [5m]))',
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
 * const instance = yield* Stackit.Observability.Instance("Telemetry", {
 *   plan: "Observability-Starter-EU01",
 * });
 * const group = yield* Stackit.Observability.LogsAlertGroup("Errors", {
 *   instanceId: instance.instanceId,
 *   name: "errors-v2",
 *   rules: [{ alert: "ErrorBurst", expr: 'sum(rate({app="api"} |= "error" [5m])) > 1' }],
 * });
 * ```
 *
 * @resource
 * @product STACKIT Observability
 * @category Observability
 */
export const LogsAlertGroup = Resource<LogsAlertGroup>("Stackit.Observability.LogsAlertGroup");

const api: AlertGroupApi<
  | observability.GetLogsAlertgroupError
  | observability.ListLogsAlertgroupsError
  | observability.CreateLogsAlertgroupsError
  | observability.UpdateLogsAlertgroupError
  | observability.DeleteLogsAlertgroupError,
  observability.StackitOpContext
> = {
  get: (scope: InstanceScope, groupName) =>
    observability.getLogsAlertgroup({ ...scope, groupName }).pipe(
      Effect.map(({ data }) => data),
      Effect.catchTag("NotFound", () => Effect.undefined),
    ),
  list: (scope) => observability.listLogsAlertgroups(scope).pipe(Effect.map(({ data }) => data)),
  create: (scope, name, interval, rules) =>
    observability.createLogsAlertgroups({ ...scope, name, interval, rules }),
  update: (scope, groupName, interval, rules) =>
    observability.updateLogsAlertgroup({ ...scope, groupName, interval, rules }),
  remove: (scope, groupName) =>
    observability.deleteLogsAlertgroup({ ...scope, groupName }).pipe(
      Effect.asVoid,
      Effect.catchTag("NotFound", () => Effect.void),
    ),
};

export const LogsAlertGroupProvider = () => {
  const lifecycle = makeAlertGroupLifecycle({
    label: "STACKIT Observability logs alert group",
    api,
  });

  return Provider.succeed(LogsAlertGroup, {
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
