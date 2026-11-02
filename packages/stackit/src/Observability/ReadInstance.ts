import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GetAlertConfigRequest } from "./GetAlertConfig.ts";
import type { GetAlertConfigReceiverRequest } from "./GetAlertConfigReceiver.ts";
import type { GetAlertConfigRouteRequest } from "./GetAlertConfigRoute.ts";
import type { GetAlertGroupRequest } from "./GetAlertGroup.ts";
import type { GetAlertRecordRequest } from "./GetAlertRecord.ts";
import type { GetAlertRuleRequest } from "./GetAlertRule.ts";
import type { GetCredentialsRemoteWriteConfigRequest } from "./GetCredentialsRemoteWriteConfig.ts";
import type { GetGrafanaConfigsRequest } from "./GetGrafanaConfigs.ts";
import type { GetInstanceRequest } from "./GetInstance.ts";
import type { GetLogsAlertGroupRequest } from "./GetLogsAlertGroup.ts";
import type { GetLogsConfigsRequest } from "./GetLogsConfigs.ts";
import type { GetMetricsStorageRetentionRequest } from "./GetMetricsStorageRetention.ts";
import type { GetScrapeConfigRequest } from "./GetScrapeConfig.ts";
import type { GetTracesConfigsRequest } from "./GetTracesConfigs.ts";
import type { Instance } from "./Instance.ts";
import type { ListACLRequest } from "./ListACL.ts";
import type { ListAlertConfigReceiversRequest } from "./ListAlertConfigReceivers.ts";
import type { ListAlertConfigRoutesRequest } from "./ListAlertConfigRoutes.ts";
import type { ListAlertGroupsRequest } from "./ListAlertGroups.ts";
import type { ListAlertRecordsRequest } from "./ListAlertRecords.ts";
import type { ListAlertRulesRequest } from "./ListAlertRules.ts";
import type { ListBackupRetentionsRequest } from "./ListBackupRetentions.ts";
import type { ListBackupsRequest } from "./ListBackups.ts";
import type { ListBackupSchedulesRequest } from "./ListBackupSchedules.ts";
import type { ListCertChecksRequest } from "./ListCertChecks.ts";
import type { ListCredentialsRequest } from "./ListCredentials.ts";
import type { ListElasticsearchChecksRequest } from "./ListElasticsearchChecks.ts";
import type { ListHttpChecksRequest } from "./ListHttpChecks.ts";
import type { ListLogsAlertGroupsRequest } from "./ListLogsAlertGroups.ts";
import type { ListMongoDBChecksRequest } from "./ListMongoDBChecks.ts";
import type { ListMySQLChecksRequest } from "./ListMySQLChecks.ts";
import type { ListNetworkChecksRequest } from "./ListNetworkChecks.ts";
import type { ListPingChecksRequest } from "./ListPingChecks.ts";
import type { ListPostgreSQLChecksRequest } from "./ListPostgreSQLChecks.ts";
import type { ListRabbitMQChecksRequest } from "./ListRabbitMQChecks.ts";
import type { ListRedisChecksRequest } from "./ListRedisChecks.ts";
import type { ListScrapeConfigsRequest } from "./ListScrapeConfigs.ts";

/** The read operations on a bound instance. Its project and id are injected. */
export interface ReadInstanceClient {
  /** Read an instance's status, plan and URLs. */
  getInstance(
    request?: GetInstanceRequest,
  ): Effect.Effect<
    observability.GetInstanceResponse,
    observability.GetInstanceError,
    RuntimeContext
  >;
  /** Read the CIDR ranges allowed to reach an instance. */
  listACL(
    request?: ListACLRequest,
  ): Effect.Effect<observability.ListACLResponse, observability.ListACLError, RuntimeContext>;
  /** Read an instance's Grafana settings. */
  getGrafanaConfigs(
    request?: GetGrafanaConfigsRequest,
  ): Effect.Effect<
    observability.GrafanaConfigs,
    observability.GetGrafanaConfigsError,
    RuntimeContext
  >;
  /** Read how long an instance keeps metrics at each resolution. */
  getMetricsStorageRetention(
    request?: GetMetricsStorageRetentionRequest,
  ): Effect.Effect<
    observability.GetMetricsStorageRetentionResponse,
    observability.GetMetricsStorageRetentionError,
    RuntimeContext
  >;
  /** Read how long an instance keeps logs. */
  getLogsConfigs(
    request?: GetLogsConfigsRequest,
  ): Effect.Effect<
    observability.LogsConfigResponse,
    observability.GetLogsConfigsError,
    RuntimeContext
  >;
  /** Read how long an instance keeps traces. */
  getTracesConfigs(
    request?: GetTracesConfigsRequest,
  ): Effect.Effect<
    observability.TracesConfigResponse,
    observability.GetTracesConfigsError,
    RuntimeContext
  >;
  /** List an instance's credentials, without their passwords. */
  listCredentials(
    request?: ListCredentialsRequest,
  ): Effect.Effect<
    observability.ListCredentialsResponse,
    observability.ListCredentialsError,
    RuntimeContext
  >;
  /** Read a credential's remote-write limit. */
  getCredentialsRemoteWriteConfig(
    request: GetCredentialsRemoteWriteConfigRequest & { username: string },
  ): Effect.Effect<
    observability.CredentialsRemoteWriteConfig,
    observability.GetCredentialsRemoteWriteConfigError,
    RuntimeContext
  >;
  /** Read one scrape job. */
  getScrapeConfig(
    request: GetScrapeConfigRequest,
  ): Effect.Effect<
    observability.GetScrapeConfigResponse,
    observability.GetScrapeConfigError,
    RuntimeContext
  >;
  /** List an instance's scrape jobs. */
  listScrapeConfigs(
    request?: ListScrapeConfigsRequest,
  ): Effect.Effect<
    observability.ListScrapeConfigsResponse,
    observability.ListScrapeConfigsError,
    RuntimeContext
  >;
  /** Read one alert group and its rules. */
  getAlertGroup(
    request: GetAlertGroupRequest,
  ): Effect.Effect<
    observability.AlertGroupResponse,
    observability.GetAlertgroupError,
    RuntimeContext
  >;
  /** List an instance's alert groups. */
  listAlertGroups(
    request?: ListAlertGroupsRequest,
  ): Effect.Effect<
    observability.AlertGroupsResponse,
    observability.ListAlertgroupsError,
    RuntimeContext
  >;
  /** Read one alert rule of a group. */
  getAlertRule(
    request: GetAlertRuleRequest,
  ): Effect.Effect<
    observability.AlertRuleResponse,
    observability.GetAlertruleError,
    RuntimeContext
  >;
  /** List a group's alert rules. */
  listAlertRules(
    request: ListAlertRulesRequest,
  ): Effect.Effect<
    observability.AlertRulesResponse,
    observability.ListAlertrulesError,
    RuntimeContext
  >;
  /** Read one recording rule of a group. */
  getAlertRecord(
    request: GetAlertRecordRequest,
  ): Effect.Effect<
    observability.AlertRecordResponse,
    observability.GetAlertRecordError,
    RuntimeContext
  >;
  /** List a group's recording rules. */
  listAlertRecords(
    request: ListAlertRecordsRequest,
  ): Effect.Effect<
    observability.AlertRecordsResponse,
    observability.ListAlertRecordsError,
    RuntimeContext
  >;
  /** Read one logs alert group and its rules. */
  getLogsAlertGroup(
    request: GetLogsAlertGroupRequest,
  ): Effect.Effect<
    observability.AlertGroupResponse,
    observability.GetLogsAlertgroupError,
    RuntimeContext
  >;
  /** List an instance's logs alert groups. */
  listLogsAlertGroups(
    request?: ListLogsAlertGroupsRequest,
  ): Effect.Effect<
    observability.AlertGroupsResponse,
    observability.ListLogsAlertgroupsError,
    RuntimeContext
  >;
  /** Read an instance's whole Alertmanager configuration. */
  getAlertConfig(
    request?: GetAlertConfigRequest,
  ): Effect.Effect<
    observability.GetAlertConfigsResponse,
    observability.GetAlertConfigsError,
    RuntimeContext
  >;
  /** List an instance's alert receivers. */
  listAlertConfigReceivers(
    request?: ListAlertConfigReceiversRequest,
  ): Effect.Effect<
    observability.AlertConfigReceiversResponse,
    observability.ListAlertConfigReceiversError,
    RuntimeContext
  >;
  /** Read one alert receiver. */
  getAlertConfigReceiver(
    request: GetAlertConfigReceiverRequest,
  ): Effect.Effect<
    observability.Receiver,
    observability.GetAlertConfigReceiverError,
    RuntimeContext
  >;
  /** Read an instance's alert routing tree. */
  listAlertConfigRoutes(
    request?: ListAlertConfigRoutesRequest,
  ): Effect.Effect<
    observability.AlertConfigRouteResponse,
    observability.ListAlertConfigRoutesError,
    RuntimeContext
  >;
  /** Read the route of one receiver. */
  getAlertConfigRoute(
    request: GetAlertConfigRouteRequest,
  ): Effect.Effect<
    observability.AlertConfigRouteResponse,
    observability.GetAlertConfigRouteError,
    RuntimeContext
  >;
  /** List an instance's cert checks. */
  listCertChecks(
    request?: ListCertChecksRequest,
  ): Effect.Effect<
    observability.CertCheckResponse,
    observability.ListCertChecksError,
    RuntimeContext
  >;
  /** List an instance's Elasticsearch checks. */
  listElasticsearchChecks(
    request?: ListElasticsearchChecksRequest,
  ): Effect.Effect<
    observability.ElasticsearchCheckResponse,
    observability.ListElasticsearchChecksError,
    RuntimeContext
  >;
  /** List an instance's HTTP checks. */
  listHttpChecks(
    request?: ListHttpChecksRequest,
  ): Effect.Effect<
    observability.HttpCheckResponse,
    observability.ListHttpChecksError,
    RuntimeContext
  >;
  /** List an instance's MongoDB checks. */
  listMongoDBChecks(
    request?: ListMongoDBChecksRequest,
  ): Effect.Effect<
    observability.MongodbCheckResponse,
    observability.ListMongodbChecksError,
    RuntimeContext
  >;
  /** List an instance's MySQL checks. */
  listMySQLChecks(
    request?: ListMySQLChecksRequest,
  ): Effect.Effect<
    observability.MysqlCheckResponse,
    observability.ListMysqlChecksError,
    RuntimeContext
  >;
  /** List an instance's network checks. */
  listNetworkChecks(
    request?: ListNetworkChecksRequest,
  ): Effect.Effect<
    observability.NetworkCheckResponse,
    observability.ListNetworkChecksError,
    RuntimeContext
  >;
  /** List an instance's ping checks. */
  listPingChecks(
    request?: ListPingChecksRequest,
  ): Effect.Effect<
    observability.PingCheckResponse,
    observability.ListPingChecksError,
    RuntimeContext
  >;
  /** List an instance's PostgreSQL checks. */
  listPostgreSQLChecks(
    request?: ListPostgreSQLChecksRequest,
  ): Effect.Effect<
    observability.PostgresqlCheckResponse,
    observability.ListPostgresqlChecksError,
    RuntimeContext
  >;
  /** List an instance's RabbitMQ checks. */
  listRabbitMQChecks(
    request?: ListRabbitMQChecksRequest,
  ): Effect.Effect<
    observability.RabbitmqCheckResponse,
    observability.ListRabbitmqChecksError,
    RuntimeContext
  >;
  /** List an instance's Redis checks. */
  listRedisChecks(
    request?: ListRedisChecksRequest,
  ): Effect.Effect<
    observability.RedisCheckResponse,
    observability.ListRedisChecksError,
    RuntimeContext
  >;
  /** List an instance's backups by target. */
  listBackups(
    request?: ListBackupsRequest,
  ): Effect.Effect<observability.BackupResponse, observability.ListBackupsError, RuntimeContext>;
  /** Read how long an instance keeps each kind of backup. */
  listBackupRetentions(
    request?: ListBackupRetentionsRequest,
  ): Effect.Effect<
    observability.BackupRetentionResponse,
    observability.ListBackupRetentionsError,
    RuntimeContext
  >;
  /** List an instance's backup schedules by target. */
  listBackupSchedules(
    request?: ListBackupSchedulesRequest,
  ): Effect.Effect<
    observability.BackupScheduleResponse,
    observability.ListBackupSchedulesError,
    RuntimeContext
  >;
}

/**
 * Read an {@link Instance}'s configuration from a Function/Worker: its status,
 * retentions, scrape jobs, alert groups and rules, alert configuration, checks and
 * backups.
 *
 * Bind it in the init phase and provide {@link ReadInstanceHttp}. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * ### Reading an Instance
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
 *     const client = yield* Stackit.Observability.ReadInstance(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { data } = yield* client.listAlertGroups();
 *         return yield* HttpServerResponse.json({ groups: data.map((group) => group.name) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ReadInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ReadInstance extends Binding.Service<
  ReadInstance,
  "Stackit.Observability.ReadInstance",
  (instance: Instance) => Effect.Effect<ReadInstanceClient>
> {}

export const ReadInstance = Binding.Service<ReadInstance>("Stackit.Observability.ReadInstance");
