import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CreateAlertConfigReceiverRequest } from "./CreateAlertConfigReceiver.ts";
import type { CreateAlertConfigRouteRequest } from "./CreateAlertConfigRoute.ts";
import type { CreateAlertGroupRequest } from "./CreateAlertGroup.ts";
import type { CreateAlertRecordRequest } from "./CreateAlertRecord.ts";
import type { CreateAlertRuleRequest } from "./CreateAlertRule.ts";
import type { CreateBackupRequest } from "./CreateBackup.ts";
import type { CreateBackupScheduleRequest } from "./CreateBackupSchedule.ts";
import type { CreateLogsAlertGroupRequest } from "./CreateLogsAlertGroup.ts";
import type { CreateScrapeConfigRequest } from "./CreateScrapeConfig.ts";
import type { DeleteAlertConfigReceiverRequest } from "./DeleteAlertConfigReceiver.ts";
import type { DeleteAlertConfigRouteRequest } from "./DeleteAlertConfigRoute.ts";
import type { DeleteAlertGroupRequest } from "./DeleteAlertGroup.ts";
import type { DeleteAlertGroupsRequest } from "./DeleteAlertGroups.ts";
import type { DeleteAlertRecordRequest } from "./DeleteAlertRecord.ts";
import type { DeleteAlertRecordsRequest } from "./DeleteAlertRecords.ts";
import type { DeleteAlertRuleRequest } from "./DeleteAlertRule.ts";
import type { DeleteAlertRulesRequest } from "./DeleteAlertRules.ts";
import type { DeleteLogsAlertGroupRequest } from "./DeleteLogsAlertGroup.ts";
import type { DeleteScrapeConfigRequest } from "./DeleteScrapeConfig.ts";
import type { DeleteScrapeConfigsRequest } from "./DeleteScrapeConfigs.ts";
import type { Instance } from "./Instance.ts";
import type { RestoreBackupRequest } from "./RestoreBackup.ts";
import type { UpdateAlertConfigReceiverRequest } from "./UpdateAlertConfigReceiver.ts";
import type { UpdateAlertConfigRouteRequest } from "./UpdateAlertConfigRoute.ts";
import type { UpdateAlertGroupRequest } from "./UpdateAlertGroup.ts";
import type { UpdateAlertRecordRequest } from "./UpdateAlertRecord.ts";
import type { UpdateAlertRuleRequest } from "./UpdateAlertRule.ts";
import type { UpdateCredentialsRemoteWriteConfigRequest } from "./UpdateCredentialsRemoteWriteConfig.ts";
import type { UpdateLogsAlertGroupRequest } from "./UpdateLogsAlertGroup.ts";
import type { UpdateScrapeConfigRequest } from "./UpdateScrapeConfig.ts";
import type { UpsertAlertGroupsRequest } from "./UpsertAlertGroups.ts";
import type { UpsertAlertRecordsRequest } from "./UpsertAlertRecords.ts";
import type { UpsertAlertRulesRequest } from "./UpsertAlertRules.ts";
import type { UpsertScrapeConfigsRequest } from "./UpsertScrapeConfigs.ts";

/** The write operations on a bound instance. Its project and id are injected. */
export interface WriteInstanceClient {
  /** Change a credential's remote-write limit. */
  updateCredentialsRemoteWriteConfig(
    request: UpdateCredentialsRemoteWriteConfigRequest & { username: string },
  ): Effect.Effect<
    observability.CredentialsRemoteWriteConfig,
    observability.UpdateCredentialsRemoteWriteConfigError,
    RuntimeContext
  >;
  /** Add a scrape job to an instance. */
  createScrapeConfig(
    request: CreateScrapeConfigRequest,
  ): Effect.Effect<
    observability.ScrapeConfigsResponse,
    observability.CreateScrapeConfigError,
    RuntimeContext
  >;
  /** Replace a scrape job's settings. */
  updateScrapeConfig(
    request: UpdateScrapeConfigRequest,
  ): Effect.Effect<
    observability.ScrapeConfigsResponse,
    observability.UpdateScrapeConfigError,
    RuntimeContext
  >;
  /** Remove one scrape job. */
  deleteScrapeConfig(
    request: DeleteScrapeConfigRequest,
  ): Effect.Effect<
    observability.DeleteScrapeConfigResponse,
    observability.DeleteScrapeConfigError,
    RuntimeContext
  >;
  /** Create or update several scrape jobs in one call. */
  upsertScrapeConfigs(
    request: UpsertScrapeConfigsRequest,
  ): Effect.Effect<
    observability.ScrapeConfigsResponse,
    observability.PartialUpdateScrapeConfigsError,
    RuntimeContext
  >;
  /** Remove several scrape jobs in one call. */
  deleteScrapeConfigs(
    request: DeleteScrapeConfigsRequest,
  ): Effect.Effect<
    observability.ScrapeConfigsResponse,
    observability.DeleteScrapeConfigsError,
    RuntimeContext
  >;
  /** Add an alert group to an instance. */
  createAlertGroup(
    request: CreateAlertGroupRequest,
  ): Effect.Effect<
    observability.AlertGroupsResponse,
    observability.CreateAlertgroupsError,
    RuntimeContext
  >;
  /** Replace an alert group's interval and rules. */
  updateAlertGroup(
    request: UpdateAlertGroupRequest,
  ): Effect.Effect<
    observability.AlertGroupsResponse,
    observability.UpdateAlertgroupError,
    RuntimeContext
  >;
  /** Remove one alert group. */
  deleteAlertGroup(
    request: DeleteAlertGroupRequest,
  ): Effect.Effect<
    observability.AlertGroupsResponse,
    observability.DeleteAlertgroupError,
    RuntimeContext
  >;
  /** Create or update several alert groups in one call. */
  upsertAlertGroups(
    request: UpsertAlertGroupsRequest,
  ): Effect.Effect<
    observability.AlertGroupsResponse,
    observability.PartialUpdateAlertgroupsError,
    RuntimeContext
  >;
  /** Remove several alert groups in one call. */
  deleteAlertGroups(
    request: DeleteAlertGroupsRequest,
  ): Effect.Effect<
    observability.AlertGroupsResponse,
    observability.DeleteAlertgroupsError,
    RuntimeContext
  >;
  /** Add one alert rule to a group. */
  createAlertRule(
    request: CreateAlertRuleRequest,
  ): Effect.Effect<
    observability.AlertRulesResponse,
    observability.CreateAlertrulesError,
    RuntimeContext
  >;
  /** Replace one alert rule's expression, labels and timing. */
  updateAlertRule(
    request: UpdateAlertRuleRequest,
  ): Effect.Effect<
    observability.AlertRulesResponse,
    observability.UpdateAlertruleError,
    RuntimeContext
  >;
  /** Remove one alert rule from a group. */
  deleteAlertRule(
    request: DeleteAlertRuleRequest,
  ): Effect.Effect<
    observability.AlertRulesResponse,
    observability.DeleteAlertruleError,
    RuntimeContext
  >;
  /** Create or update several alert rules of a group in one call. */
  upsertAlertRules(
    request: UpsertAlertRulesRequest,
  ): Effect.Effect<
    observability.AlertRulesResponse,
    observability.PartialUpdateAlertrulesError,
    RuntimeContext
  >;
  /** Remove several alert rules from a group in one call. */
  deleteAlertRules(
    request: DeleteAlertRulesRequest,
  ): Effect.Effect<
    observability.AlertRulesResponse,
    observability.DeleteAlertrulesError,
    RuntimeContext
  >;
  /** Add one recording rule to a group. */
  createAlertRecord(
    request: CreateAlertRecordRequest,
  ): Effect.Effect<
    observability.AlertRecordsResponse,
    observability.CreateAlertRecordError,
    RuntimeContext
  >;
  /** Replace one recording rule's expression and labels. */
  updateAlertRecord(
    request: UpdateAlertRecordRequest,
  ): Effect.Effect<
    observability.AlertRecordsResponse,
    observability.UpdateAlertRecordError,
    RuntimeContext
  >;
  /** Remove one recording rule from a group. */
  deleteAlertRecord(
    request: DeleteAlertRecordRequest,
  ): Effect.Effect<
    observability.AlertRecordsResponse,
    observability.DeleteAlertRecordError,
    RuntimeContext
  >;
  /** Create or update several recording rules of a group in one call. */
  upsertAlertRecords(
    request: UpsertAlertRecordsRequest,
  ): Effect.Effect<
    observability.AlertRecordsResponse,
    observability.PartialUpdateAlertRecordsError,
    RuntimeContext
  >;
  /** Remove several recording rules from a group in one call. */
  deleteAlertRecords(
    request: DeleteAlertRecordsRequest,
  ): Effect.Effect<
    observability.AlertRecordsResponse,
    observability.DeleteAlertRecordsError,
    RuntimeContext
  >;
  /** Add a group of LogQL alert rules to an instance. */
  createLogsAlertGroup(
    request: CreateLogsAlertGroupRequest,
  ): Effect.Effect<
    observability.AlertGroupsResponse,
    observability.CreateLogsAlertgroupsError,
    RuntimeContext
  >;
  /** Replace a logs alert group's interval and rules. */
  updateLogsAlertGroup(
    request: UpdateLogsAlertGroupRequest,
  ): Effect.Effect<
    observability.AlertGroupsResponse,
    observability.UpdateLogsAlertgroupError,
    RuntimeContext
  >;
  /** Remove one logs alert group. */
  deleteLogsAlertGroup(
    request: DeleteLogsAlertGroupRequest,
  ): Effect.Effect<
    observability.AlertGroupsResponse,
    observability.DeleteLogsAlertgroupError,
    RuntimeContext
  >;
  /** Add one alert receiver. */
  createAlertConfigReceiver(
    request: CreateAlertConfigReceiverRequest,
  ): Effect.Effect<
    observability.AlertConfigReceiversResponse,
    observability.CreateAlertConfigReceiverError,
    RuntimeContext
  >;
  /** Replace one alert receiver's configuration. */
  updateAlertConfigReceiver(
    request: UpdateAlertConfigReceiverRequest,
  ): Effect.Effect<
    observability.AlertConfigReceiversResponse,
    observability.UpdateAlertConfigReceiverError,
    RuntimeContext
  >;
  /** Remove one alert receiver. */
  deleteAlertConfigReceiver(
    request: DeleteAlertConfigReceiverRequest,
  ): Effect.Effect<
    observability.AlertConfigReceiversResponse,
    observability.DeleteAlertConfigReceiverError,
    RuntimeContext
  >;
  /** Add a route for one receiver. */
  createAlertConfigRoute(
    request: CreateAlertConfigRouteRequest,
  ): Effect.Effect<
    observability.AlertConfigRouteResponse,
    observability.CreateAlertConfigRouteError,
    RuntimeContext
  >;
  /** Replace the route of one receiver. */
  updateAlertConfigRoute(
    request: UpdateAlertConfigRouteRequest,
  ): Effect.Effect<
    observability.AlertConfigRouteResponse,
    observability.UpdateAlertConfigRouteError,
    RuntimeContext
  >;
  /** Remove the route of one receiver. */
  deleteAlertConfigRoute(
    request: DeleteAlertConfigRouteRequest,
  ): Effect.Effect<
    observability.AlertConfigRouteResponse,
    observability.DeleteAlertConfigRouteError,
    RuntimeContext
  >;
  /** Take a backup of an instance's configuration before a risky change. */
  createBackup(
    request?: CreateBackupRequest,
  ): Effect.Effect<observability.Message, observability.CreateBackupError, RuntimeContext>;
  /** Restore a part of an instance's configuration from a backup. */
  restoreBackup(
    request: RestoreBackupRequest,
  ): Effect.Effect<observability.Message, observability.RestoreBackupError, RuntimeContext>;
  /** Schedule backups of an instance's configuration. */
  createBackupSchedule(
    request: CreateBackupScheduleRequest,
  ): Effect.Effect<
    observability.BackupSchedulePostResponse,
    observability.CreateBackupScheduleError,
    RuntimeContext
  >;
}

/**
 * Change an {@link Instance}'s configuration from a Function/Worker: its scrape jobs,
 * alert groups and rules, receivers and routes, remote-write limits and backups.
 *
 * Bind it in the init phase and provide {@link WriteInstanceHttp}. A foreign host
 * signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with `argus.instance.update`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. It is the only write permission this API has, and STACKIT binds roles on
 * projects at the narrowest, so the host can change the whole configuration of every
 * Observability instance in that project. A resource that declares what this client
 * changes overwrites it on its next reconcile: `AlertConfig` writes the whole alert
 * configuration, and `ScrapeConfig`, `AlertGroup` and `LogsAlertGroup` their own job
 * or group.
 *
 * ### Changing an Instance
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Metrics = Stackit.Observability.Instance("Metrics", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const metrics = yield* Metrics;
 *     const client = yield* Stackit.Observability.WriteInstance(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { data } = yield* client.createAlertGroup({
 *           name: "orders",
 *           rules: [{ alert: "HighLatency", expr: "latency_seconds > 2" }],
 *         });
 *         return yield* HttpServerResponse.json({ groups: data.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.WriteInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface WriteInstance extends Binding.Service<
  WriteInstance,
  "Stackit.Observability.WriteInstance",
  (instance: Instance) => Effect.Effect<WriteInstanceClient>
> {}

export const WriteInstance = Binding.Service<WriteInstance>("Stackit.Observability.WriteInstance");
