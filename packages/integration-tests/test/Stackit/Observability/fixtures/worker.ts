import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

/** The cheapest plan with logs and traces: the logs bindings need them. */
export const STARTER_PLAN = "Observability-Starter-EU01";

/**
 * A Worker's egress addresses aren't a fixed range, and the data bindings have to reach the
 * instance. Nothing but this suite's data lives on it.
 */
export const FIXTURE_ACL = "0.0.0.0/0";

export const SEEDED_EXPR = "vector(1) > 2";

export const Metrics = Stackit.Observability.Instance("ObservabilityBindingsInstance", {
  plan: STARTER_PLAN,
  acl: [FIXTURE_ACL],
});

export const Tenant = Metrics.pipe(
  Effect.flatMap((metrics) =>
    Stackit.Observability.Credential("ObservabilityBindingsCredential", {
      instanceId: metrics.instanceId,
    }),
  ),
);

const scrapeJob = (jobName: string, scrapeInterval = "5m") => ({
  jobName,
  scheme: "https" as const,
  scrapeInterval,
  scrapeTimeout: "2m",
  metricsPath: "/metrics",
  staticConfigs: [{ targets: ["example.com:443"] }],
});
const rule = (alert: string) => ({ alert, expr: SEEDED_EXPR, for: "2m" });
const record = (name: string) => ({ record: name, expr: "vector(1)" });
const logRule = (alert: string) => ({
  alert,
  expr: 'sum(rate({app="alchemy"}[5m])) > 1',
  for: "2m",
});
const receiverBody = (name: string) => ({
  name,
  webHookConfigs: [{ url: Redacted.make("https://example.com/alchemy-test") }],
});

/**
 * A Cloudflare Worker with every Observability binding. One route per binding; each answers
 * `{ ok, result | error }`, so a failure surfaces the STACKIT error in the test. Routes map
 * a response to the fields a test asserts: many hold secrets, and `Redacted` values print a
 * marker anyway.
 */
export default class ObservabilityBindingsWorker extends Cloudflare.Worker<ObservabilityBindingsWorker>()(
  "StackitObservabilityBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const metrics = yield* Metrics;
    const credential = yield* Tenant;
    const getInstance = yield* Stackit.Observability.GetInstance(metrics);
    const listInstances = yield* Stackit.Observability.ListInstances(metrics);
    const listACL = yield* Stackit.Observability.ListACL(metrics);
    const getGrafanaConfigs = yield* Stackit.Observability.GetGrafanaConfigs(metrics);
    const getMetricsStorageRetention =
      yield* Stackit.Observability.GetMetricsStorageRetention(metrics);
    const getLogsConfigs = yield* Stackit.Observability.GetLogsConfigs(metrics);
    const getTracesConfigs = yield* Stackit.Observability.GetTracesConfigs(metrics);
    const listPlans = yield* Stackit.Observability.ListPlans(metrics);
    const listOfferings = yield* Stackit.Observability.ListOfferings(metrics);
    const listCredentials = yield* Stackit.Observability.ListCredentials(metrics);
    const updateCredentialsRemoteWriteConfig =
      yield* Stackit.Observability.UpdateCredentialsRemoteWriteConfig(credential);
    const getCredentialsRemoteWriteConfig =
      yield* Stackit.Observability.GetCredentialsRemoteWriteConfig(credential);
    const createScrapeConfig = yield* Stackit.Observability.CreateScrapeConfig(metrics);
    const getScrapeConfig = yield* Stackit.Observability.GetScrapeConfig(metrics);
    const listScrapeConfigs = yield* Stackit.Observability.ListScrapeConfigs(metrics);
    const updateScrapeConfig = yield* Stackit.Observability.UpdateScrapeConfig(metrics);
    const deleteScrapeConfig = yield* Stackit.Observability.DeleteScrapeConfig(metrics);
    const upsertScrapeConfigs = yield* Stackit.Observability.UpsertScrapeConfigs(metrics);
    const deleteScrapeConfigs = yield* Stackit.Observability.DeleteScrapeConfigs(metrics);
    const createAlertGroup = yield* Stackit.Observability.CreateAlertGroup(metrics);
    const getAlertGroup = yield* Stackit.Observability.GetAlertGroup(metrics);
    const listAlertGroups = yield* Stackit.Observability.ListAlertGroups(metrics);
    const updateAlertGroup = yield* Stackit.Observability.UpdateAlertGroup(metrics);
    const deleteAlertGroup = yield* Stackit.Observability.DeleteAlertGroup(metrics);
    const upsertAlertGroups = yield* Stackit.Observability.UpsertAlertGroups(metrics);
    const deleteAlertGroups = yield* Stackit.Observability.DeleteAlertGroups(metrics);
    const createAlertRule = yield* Stackit.Observability.CreateAlertRule(metrics);
    const getAlertRule = yield* Stackit.Observability.GetAlertRule(metrics);
    const listAlertRules = yield* Stackit.Observability.ListAlertRules(metrics);
    const updateAlertRule = yield* Stackit.Observability.UpdateAlertRule(metrics);
    const deleteAlertRule = yield* Stackit.Observability.DeleteAlertRule(metrics);
    const upsertAlertRules = yield* Stackit.Observability.UpsertAlertRules(metrics);
    const deleteAlertRules = yield* Stackit.Observability.DeleteAlertRules(metrics);
    const createAlertRecord = yield* Stackit.Observability.CreateAlertRecord(metrics);
    const getAlertRecord = yield* Stackit.Observability.GetAlertRecord(metrics);
    const listAlertRecords = yield* Stackit.Observability.ListAlertRecords(metrics);
    const updateAlertRecord = yield* Stackit.Observability.UpdateAlertRecord(metrics);
    const deleteAlertRecord = yield* Stackit.Observability.DeleteAlertRecord(metrics);
    const upsertAlertRecords = yield* Stackit.Observability.UpsertAlertRecords(metrics);
    const deleteAlertRecords = yield* Stackit.Observability.DeleteAlertRecords(metrics);
    const createLogsAlertGroup = yield* Stackit.Observability.CreateLogsAlertGroup(metrics);
    const getLogsAlertGroup = yield* Stackit.Observability.GetLogsAlertGroup(metrics);
    const listLogsAlertGroups = yield* Stackit.Observability.ListLogsAlertGroups(metrics);
    const updateLogsAlertGroup = yield* Stackit.Observability.UpdateLogsAlertGroup(metrics);
    const deleteLogsAlertGroup = yield* Stackit.Observability.DeleteLogsAlertGroup(metrics);
    const getAlertConfig = yield* Stackit.Observability.GetAlertConfig(metrics);
    const listAlertConfigReceivers = yield* Stackit.Observability.ListAlertConfigReceivers(metrics);
    const getAlertConfigReceiver = yield* Stackit.Observability.GetAlertConfigReceiver(metrics);
    const createAlertConfigReceiver =
      yield* Stackit.Observability.CreateAlertConfigReceiver(metrics);
    const updateAlertConfigReceiver =
      yield* Stackit.Observability.UpdateAlertConfigReceiver(metrics);
    const deleteAlertConfigReceiver =
      yield* Stackit.Observability.DeleteAlertConfigReceiver(metrics);
    const listAlertConfigRoutes = yield* Stackit.Observability.ListAlertConfigRoutes(metrics);
    const getAlertConfigRoute = yield* Stackit.Observability.GetAlertConfigRoute(metrics);
    const createAlertConfigRoute = yield* Stackit.Observability.CreateAlertConfigRoute(metrics);
    const updateAlertConfigRoute = yield* Stackit.Observability.UpdateAlertConfigRoute(metrics);
    const deleteAlertConfigRoute = yield* Stackit.Observability.DeleteAlertConfigRoute(metrics);
    const listCertChecks = yield* Stackit.Observability.ListCertChecks(metrics);
    const listElasticsearchChecks = yield* Stackit.Observability.ListElasticsearchChecks(metrics);
    const listHttpChecks = yield* Stackit.Observability.ListHttpChecks(metrics);
    const listMongoDBChecks = yield* Stackit.Observability.ListMongoDBChecks(metrics);
    const listMySQLChecks = yield* Stackit.Observability.ListMySQLChecks(metrics);
    const listNetworkChecks = yield* Stackit.Observability.ListNetworkChecks(metrics);
    const listPingChecks = yield* Stackit.Observability.ListPingChecks(metrics);
    const listPostgreSQLChecks = yield* Stackit.Observability.ListPostgreSQLChecks(metrics);
    const listRabbitMQChecks = yield* Stackit.Observability.ListRabbitMQChecks(metrics);
    const listRedisChecks = yield* Stackit.Observability.ListRedisChecks(metrics);
    const createBackup = yield* Stackit.Observability.CreateBackup(metrics);
    const listBackups = yield* Stackit.Observability.ListBackups(metrics);
    const listBackupRetentions = yield* Stackit.Observability.ListBackupRetentions(metrics);
    const restoreBackup = yield* Stackit.Observability.RestoreBackup(metrics);
    const createBackupSchedule = yield* Stackit.Observability.CreateBackupSchedule(metrics);
    const listBackupSchedules = yield* Stackit.Observability.ListBackupSchedules(metrics);
    const readInstance = yield* Stackit.Observability.ReadInstance(metrics);
    const writeInstance = yield* Stackit.Observability.WriteInstance(metrics);
    const readWriteInstance = yield* Stackit.Observability.ReadWriteInstance(metrics);
    const queryMetrics = yield* Stackit.Observability.QueryMetrics(metrics, credential);
    const alerts = yield* Stackit.Observability.Alerts(metrics, credential);
    const pushLogs = yield* Stackit.Observability.PushLogs(metrics, credential);
    const queryLogs = yield* Stackit.Observability.QueryLogs(metrics, credential);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        const names = () => param("names").split(",");
        const now = yield* Clock.currentTimeMillis;
        switch (url.pathname) {
          case "/get-instance":
            return yield* respond(
              getInstance().pipe(Effect.map((live) => ({ id: live.id, planName: live.planName }))),
            );
          case "/list-instances":
            return yield* respond(
              listInstances().pipe(
                Effect.map(({ instances }) => ({ ids: instances.map((item) => item.id) })),
              ),
            );
          case "/list-acl":
            return yield* respond(listACL().pipe(Effect.map(({ acl }) => ({ acl }))));
          case "/get-grafana-configs":
            return yield* respond(
              getGrafanaConfigs().pipe(
                Effect.map((live) => ({ useStackitSso: live.useStackitSso })),
              ),
            );
          case "/get-metrics-storage-retention":
            return yield* respond(
              getMetricsStorageRetention().pipe(
                Effect.map((live) => ({ raw: live.metricsRetentionTimeRaw })),
              ),
            );
          case "/get-logs-configs":
            return yield* respond(
              getLogsConfigs().pipe(Effect.map((live) => ({ retention: live.config.retention }))),
            );
          case "/get-traces-configs":
            return yield* respond(
              getTracesConfigs().pipe(Effect.map((live) => ({ retention: live.config.retention }))),
            );
          case "/list-plans":
            return yield* respond(
              listPlans().pipe(
                Effect.map(({ plans }) => ({ names: plans.map((plan) => plan.name) })),
              ),
            );
          case "/list-offerings":
            return yield* respond(
              listOfferings().pipe(
                Effect.map((live) => ({ plans: live.plans.map((plan) => plan.name) })),
              ),
            );
          case "/list-credentials":
            return yield* respond(
              listCredentials().pipe(
                Effect.map(({ credentials }) => ({
                  usernames: credentials.map((item) => item.name),
                })),
              ),
            );
          case "/update-credentials-remote-write-config":
            return yield* respond(
              updateCredentialsRemoteWriteConfig({ maxLimit: Number(param("limit")) }).pipe(
                Effect.map((live) => ({ maxLimit: live.maxLimit })),
              ),
            );
          case "/get-credentials-remote-write-config":
            return yield* respond(
              getCredentialsRemoteWriteConfig().pipe(
                Effect.map((live) => ({ maxLimit: live.maxLimit })),
              ),
            );
          case "/create-scrape-config":
            return yield* respond(
              createScrapeConfig(scrapeJob(param("name"))).pipe(
                Effect.map(({ data }) => ({ jobs: data.map((job) => job.jobName) })),
              ),
            );
          case "/get-scrape-config":
            return yield* respond(
              getScrapeConfig({ jobName: param("name") }).pipe(
                Effect.map(({ data }) => ({
                  jobName: data.jobName,
                  scrapeInterval: data.scrapeInterval,
                })),
              ),
            );
          case "/list-scrape-configs":
            return yield* respond(
              listScrapeConfigs().pipe(
                Effect.map(({ data }) => ({ jobs: data.map((job) => job.jobName) })),
              ),
            );
          case "/update-scrape-config":
            return yield* respond(
              updateScrapeConfig(scrapeJob(param("name"), "10m")).pipe(
                Effect.map(({ data }) => ({ jobs: data.map((job) => job.jobName) })),
              ),
            );
          case "/delete-scrape-config":
            return yield* respond(
              deleteScrapeConfig({ jobName: param("name") }).pipe(
                Effect.map(({ data }) => ({ jobs: data.map((job) => job.jobName) })),
              ),
            );
          case "/upsert-scrape-configs":
            return yield* respond(
              upsertScrapeConfigs({ body: [scrapeJob(param("name"))] }).pipe(
                Effect.map(({ data }) => ({ jobs: data.map((job) => job.jobName) })),
              ),
            );
          case "/delete-scrape-configs":
            return yield* respond(
              deleteScrapeConfigs({ jobName: names() }).pipe(
                Effect.map(({ data }) => ({ jobs: data.map((job) => job.jobName) })),
              ),
            );
          case "/create-alert-group":
            return yield* respond(
              createAlertGroup({ name: param("name"), rules: [rule("BindRule")] }).pipe(
                Effect.map(({ data }) => ({ groups: data.map((group) => group.name) })),
              ),
            );
          case "/get-alert-group":
            return yield* respond(
              getAlertGroup({ groupName: param("name") }).pipe(
                Effect.map(({ data }) => ({ name: data.name, rules: data.rules.length })),
              ),
            );
          case "/list-alert-groups":
            return yield* respond(
              listAlertGroups().pipe(
                Effect.map(({ data }) => ({ groups: data.map((group) => group.name) })),
              ),
            );
          case "/update-alert-group":
            return yield* respond(
              updateAlertGroup({
                groupName: param("name"),
                interval: "5m",
                rules: [rule("BindUpdated")],
              }).pipe(Effect.map(({ data }) => ({ groups: data.map((group) => group.name) }))),
            );
          case "/delete-alert-group":
            return yield* respond(
              deleteAlertGroup({ groupName: param("name") }).pipe(
                Effect.map(({ data }) => ({ groups: data.map((group) => group.name) })),
              ),
            );
          case "/upsert-alert-groups":
            return yield* respond(
              upsertAlertGroups({
                body: [{ name: param("name"), rules: [rule("BindRule")] }],
              }).pipe(Effect.map(({ data }) => ({ groups: data.map((group) => group.name) }))),
            );
          case "/delete-alert-groups":
            return yield* respond(
              deleteAlertGroups({ groupName: names() }).pipe(
                Effect.map(({ data }) => ({ groups: data.map((group) => group.name) })),
              ),
            );
          case "/create-alert-rule":
            return yield* respond(
              createAlertRule({ groupName: param("group"), ...rule(param("name")) }).pipe(
                Effect.map(({ data }) => ({ rules: data.map((item) => item.alert) })),
              ),
            );
          case "/get-alert-rule":
            return yield* respond(
              getAlertRule({ groupName: param("group"), alertName: param("name") }).pipe(
                Effect.map(({ data }) => ({ alert: data.alert, expr: data.expr })),
              ),
            );
          case "/list-alert-rules":
            return yield* respond(
              listAlertRules({ groupName: param("group") }).pipe(
                Effect.map(({ data }) => ({ rules: data.map((item) => item.alert) })),
              ),
            );
          case "/update-alert-rule":
            return yield* respond(
              updateAlertRule({
                groupName: param("group"),
                alertName: param("name"),
                expr: "vector(1) > 3",
              }).pipe(Effect.map(({ data }) => ({ rules: data.map((item) => item.alert) }))),
            );
          case "/delete-alert-rule":
            return yield* respond(
              deleteAlertRule({ groupName: param("group"), alertName: param("name") }).pipe(
                Effect.map(({ data }) => ({ rules: data.map((item) => item.alert) })),
              ),
            );
          case "/upsert-alert-rules":
            return yield* respond(
              upsertAlertRules({ groupName: param("group"), body: [rule(param("name"))] }).pipe(
                Effect.map(({ data }) => ({ rules: data.map((item) => item.alert) })),
              ),
            );
          case "/delete-alert-rules":
            return yield* respond(
              deleteAlertRules({ groupName: param("group"), alertName: names() }).pipe(
                Effect.map(({ data }) => ({ rules: data.map((item) => item.alert) })),
              ),
            );
          case "/create-alert-record":
            return yield* respond(
              createAlertRecord({ groupName: param("group"), ...record(param("name")) }).pipe(
                Effect.map(({ data }) => ({ records: data.map((item) => item.record) })),
              ),
            );
          case "/get-alert-record":
            return yield* respond(
              getAlertRecord({ groupName: param("group"), alertRecord: param("name") }).pipe(
                Effect.map(({ data }) => ({ record: data.record, expr: data.expr })),
              ),
            );
          case "/list-alert-records":
            return yield* respond(
              listAlertRecords({ groupName: param("group") }).pipe(
                Effect.map(({ data }) => ({ records: data.map((item) => item.record) })),
              ),
            );
          case "/update-alert-record":
            return yield* respond(
              updateAlertRecord({
                groupName: param("group"),
                alertRecord: param("name"),
                expr: "vector(2)",
              }).pipe(Effect.map(({ data }) => ({ records: data.map((item) => item.record) }))),
            );
          case "/delete-alert-record":
            return yield* respond(
              deleteAlertRecord({ groupName: param("group"), alertRecord: param("name") }).pipe(
                Effect.map(({ data }) => ({ records: data.map((item) => item.record) })),
              ),
            );
          case "/upsert-alert-records":
            return yield* respond(
              upsertAlertRecords({ groupName: param("group"), body: [record(param("name"))] }).pipe(
                Effect.map(({ data }) => ({ records: data.map((item) => item.record) })),
              ),
            );
          case "/delete-alert-records":
            return yield* respond(
              deleteAlertRecords({ groupName: param("group"), alertRecord: names() }).pipe(
                Effect.map(({ data }) => ({ records: data.map((item) => item.record) })),
              ),
            );
          case "/create-logs-alert-group":
            return yield* respond(
              createLogsAlertGroup({ name: param("name"), rules: [logRule("BindLogRule")] }).pipe(
                Effect.map(({ data }) => ({ groups: data.map((group) => group.name) })),
              ),
            );
          case "/get-logs-alert-group":
            return yield* respond(
              getLogsAlertGroup({ groupName: param("name") }).pipe(
                Effect.map(({ data }) => ({ name: data.name, rules: data.rules.length })),
              ),
            );
          case "/list-logs-alert-groups":
            return yield* respond(
              listLogsAlertGroups().pipe(
                Effect.map(({ data }) => ({ groups: data.map((group) => group.name) })),
              ),
            );
          case "/update-logs-alert-group":
            return yield* respond(
              updateLogsAlertGroup({
                groupName: param("name"),
                interval: "5m",
                rules: [logRule("BindLogUpdated")],
              }).pipe(Effect.map(({ data }) => ({ groups: data.map((group) => group.name) }))),
            );
          case "/delete-logs-alert-group":
            return yield* respond(
              deleteLogsAlertGroup({ groupName: param("name") }).pipe(
                Effect.map(({ data }) => ({ groups: data.map((group) => group.name) })),
              ),
            );
          case "/get-alert-config":
            return yield* respond(
              getAlertConfig().pipe(
                Effect.map(({ data }) => ({ receivers: data.receivers.map((item) => item.name) })),
              ),
            );
          case "/list-alert-config-receivers":
            return yield* respond(
              listAlertConfigReceivers().pipe(
                Effect.map(({ data }) => ({ receivers: data.map((item) => item.name) })),
              ),
            );
          case "/get-alert-config-receiver":
            return yield* respond(
              getAlertConfigReceiver({ receiver: param("name") }).pipe(
                Effect.map(({ data }) => ({
                  name: data.name,
                  webhooks: data.webHookConfigs?.length ?? 0,
                })),
              ),
            );
          case "/create-alert-config-receiver":
            return yield* respond(
              createAlertConfigReceiver(receiverBody(param("name"))).pipe(
                Effect.map(({ data }) => ({ receivers: data.map((item) => item.name) })),
              ),
            );
          case "/update-alert-config-receiver":
            return yield* respond(
              updateAlertConfigReceiver({
                receiver: param("name"),
                name: param("name"),
                emailConfigs: [{ to: "alerts@example.com" }],
              }).pipe(Effect.map(({ data }) => ({ receivers: data.map((item) => item.name) }))),
            );
          case "/delete-alert-config-receiver":
            return yield* respond(
              deleteAlertConfigReceiver({ receiver: param("name") }).pipe(
                Effect.map(({ data }) => ({ receivers: data.map((item) => item.name) })),
              ),
            );
          case "/list-alert-config-routes":
            return yield* respond(
              listAlertConfigRoutes().pipe(
                Effect.map(({ data }) => ({
                  routes: (data.routes ?? []).map((item) => item.receiver),
                })),
              ),
            );
          case "/get-alert-config-route":
            return yield* respond(
              getAlertConfigRoute({ receiver: param("name") }).pipe(
                Effect.map(({ data }) => ({ receiver: data.receiver })),
              ),
            );
          case "/create-alert-config-route":
            return yield* respond(
              createAlertConfigRoute({ receiver: param("name"), continue: true }).pipe(
                Effect.map(({ data }) => ({ root: data.receiver })),
              ),
            );
          case "/update-alert-config-route":
            return yield* respond(
              updateAlertConfigRoute({
                receiver: param("name"),
                groupWait: "45s",
                continue: true,
              }).pipe(Effect.map(({ data }) => ({ root: data.receiver }))),
            );
          case "/delete-alert-config-route":
            return yield* respond(
              deleteAlertConfigRoute({ receiver: param("name") }).pipe(
                Effect.map(({ data }) => ({ root: data.receiver })),
              ),
            );
          case "/list-cert-checks":
            return yield* respond(
              listCertChecks().pipe(
                Effect.map((live) => ({ ids: live.certChecks.map((check) => check.id) })),
              ),
            );
          case "/list-elasticsearch-checks":
            return yield* respond(
              listElasticsearchChecks().pipe(
                Effect.map((live) => ({ ids: live.elasticsearchChecks.map((check) => check.id) })),
              ),
            );
          case "/list-http-checks":
            return yield* respond(
              listHttpChecks().pipe(
                Effect.map((live) => ({ ids: live.httpChecks.map((check) => check.id) })),
              ),
            );
          case "/list-mongodb-checks":
            return yield* respond(
              listMongoDBChecks().pipe(
                Effect.map((live) => ({ ids: live.mongodbChecks.map((check) => check.id) })),
              ),
            );
          case "/list-mysql-checks":
            return yield* respond(
              listMySQLChecks().pipe(
                Effect.map((live) => ({ ids: live.mysqlChecks.map((check) => check.id) })),
              ),
            );
          case "/list-network-checks":
            return yield* respond(
              listNetworkChecks().pipe(
                Effect.map((live) => ({ ids: live.networkChecks.map((check) => check.id) })),
              ),
            );
          case "/list-ping-checks":
            return yield* respond(
              listPingChecks().pipe(
                Effect.map((live) => ({ ids: live.pingChecks.map((check) => check.id) })),
              ),
            );
          case "/list-postgresql-checks":
            return yield* respond(
              listPostgreSQLChecks().pipe(
                Effect.map((live) => ({ ids: live.postgresqlChecks.map((check) => check.id) })),
              ),
            );
          case "/list-rabbitmq-checks":
            return yield* respond(
              listRabbitMQChecks().pipe(
                Effect.map((live) => ({ ids: live.rabbitmqChecks.map((check) => check.id) })),
              ),
            );
          case "/list-redis-checks":
            return yield* respond(
              listRedisChecks().pipe(
                Effect.map((live) => ({ ids: live.redisChecks.map((check) => check.id) })),
              ),
            );
          case "/create-backup":
            return yield* respond(
              createBackup({ backupTarget: ["alertRules"] }).pipe(
                Effect.map((live) => ({ message: live.message })),
              ),
            );
          case "/list-backups":
            return yield* respond(
              listBackups({ backupTarget: ["alertRules"] }).pipe(
                Effect.map((live) => ({ dates: live.alertRulesBackups })),
              ),
            );
          case "/list-backup-retentions":
            return yield* respond(
              listBackupRetentions().pipe(
                Effect.map((live) => ({ alertRules: live.alertRulesBackupRetention })),
              ),
            );
          case "/restore-backup":
            return yield* respond(
              restoreBackup({ backupDate: param("date"), restoreTarget: "alertRules" }).pipe(
                Effect.map((live) => ({ message: live.message })),
              ),
            );
          case "/create-backup-schedule":
            return yield* respond(
              createBackupSchedule({ schedule: param("cron"), backupTarget: ["alertRules"] }).pipe(
                Effect.map((live) => ({ schedule: live.schedule })),
              ),
            );
          case "/list-backup-schedules":
            return yield* respond(
              listBackupSchedules({ backupTarget: ["alertRules"] }).pipe(
                Effect.map((live) => ({
                  schedules: (live.alertRulesBackupSchedules ?? []).map((item) => item.schedule),
                })),
              ),
            );
          case "/read-instance":
            return yield* respond(
              Effect.all({
                live: readInstance.getInstance(),
                groups: readInstance.getAlertGroup({ groupName: param("name") }),
              }).pipe(Effect.map(({ live, groups }) => ({ id: live.id, group: groups.data.name }))),
            );
          case "/write-instance":
            return yield* respond(
              writeInstance
                .createAlertGroup({ name: param("name"), rules: [rule("BindRule")] })
                .pipe(Effect.map(({ data }) => ({ groups: data.map((group) => group.name) }))),
            );
          case "/read-write-instance":
            return yield* respond(
              Effect.gen(function* () {
                yield* readWriteInstance.createAlertGroup({
                  name: param("name"),
                  rules: [rule("BindRule")],
                });
                return yield* readWriteInstance.getAlertGroup({ groupName: param("name") }).pipe(
                  Effect.retry({
                    while: (error) => error._tag === "NotFound",
                    schedule: Schedule.spaced("3 seconds"),
                    times: 10,
                  }),
                );
              }).pipe(Effect.map(({ data }) => ({ group: data.name }))),
            );
          case "/query-metrics":
            return yield* respond(
              Effect.all({
                instant: queryMetrics.query({ query: "vector(1)" }),
                range: queryMetrics.queryRange({
                  query: "vector(1)",
                  start: new Date(now - 60_000).toISOString(),
                  end: new Date(now).toISOString(),
                  step: "30s",
                }),
                labels: queryMetrics.labels(),
                values: queryMetrics.labelValues({ name: "job" }),
                series: queryMetrics.series({ match: ["up"] }),
              }).pipe(
                Effect.map(({ instant, range, labels, values, series }) => ({
                  instant: instant.data.result,
                  rangeType: range.data.resultType,
                  labels: labels.status,
                  values: values.status,
                  series: series.status,
                })),
              ),
            );
          case "/alerts":
            return yield* respond(
              Effect.gen(function* () {
                const name = param("name");
                yield* alerts.createAlerts({ body: [{ labels: { alertname: name } }] });
                const firing = yield* alerts.getAlerts({ filter: [`alertname="${name}"`] }).pipe(
                  Effect.repeat({
                    schedule: Schedule.spaced("2 seconds"),
                    until: (list) => list.length > 0,
                    times: 10,
                  }),
                );
                const status = yield* alerts.getStatus();
                const receivers = yield* alerts.getReceivers();
                const groups = yield* alerts.getAlertGroups();
                const { silenceID } = yield* alerts.createSilence({
                  matchers: [{ name: "alertname", value: name, isRegex: false, isEqual: true }],
                  startsAt: new Date(now).toISOString(),
                  endsAt: new Date(now + 3_600_000).toISOString(),
                  createdBy: "alchemy-test",
                  comment: "Alchemy binding test",
                });
                const silence = yield* alerts.getSilence({ silenceID: silenceID! });
                const listed = yield* alerts.getSilences();
                yield* alerts.deleteSilence({ silenceID: silenceID! });
                const expired = yield* alerts.getSilence({ silenceID: silenceID! });
                return {
                  firing: firing.map((item) => item.labels.alertname),
                  version: status.versionInfo.version,
                  receivers: receivers.length,
                  groups: groups.length,
                  silenced: silence.matchers[0]?.value,
                  listed: listed.some((item) => item.id === silenceID),
                  expiredState: expired.status.state,
                };
              }),
            );
          case "/push-logs":
            return yield* respond(
              pushLogs({
                streams: [
                  {
                    stream: { app: param("app") },
                    values: [[`${now}000000`, `line from ${param("app")}`]],
                  },
                ],
              }).pipe(Effect.map(() => ({ pushed: true }))),
            );
          case "/query-logs":
            return yield* respond(
              queryLogs
                .queryRange({ query: `{app="${param("app")}"}`, limit: 10 })
                .pipe(Effect.map((live) => ({ data: live.data }))),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mergeAll(
          Stackit.Observability.GetInstanceHttp,
          Stackit.Observability.ListInstancesHttp,
          Stackit.Observability.ListACLHttp,
          Stackit.Observability.GetGrafanaConfigsHttp,
          Stackit.Observability.GetMetricsStorageRetentionHttp,
          Stackit.Observability.GetLogsConfigsHttp,
          Stackit.Observability.GetTracesConfigsHttp,
          Stackit.Observability.ListPlansHttp,
          Stackit.Observability.ListOfferingsHttp,
          Stackit.Observability.ListCredentialsHttp,
          Stackit.Observability.UpdateCredentialsRemoteWriteConfigHttp,
          Stackit.Observability.GetCredentialsRemoteWriteConfigHttp,
          Stackit.Observability.CreateScrapeConfigHttp,
          Stackit.Observability.GetScrapeConfigHttp,
          Stackit.Observability.ListScrapeConfigsHttp,
          Stackit.Observability.UpdateScrapeConfigHttp,
          Stackit.Observability.DeleteScrapeConfigHttp,
          Stackit.Observability.UpsertScrapeConfigsHttp,
          Stackit.Observability.DeleteScrapeConfigsHttp,
          Stackit.Observability.CreateAlertGroupHttp,
        ),
        Layer.mergeAll(
          Stackit.Observability.GetAlertGroupHttp,
          Stackit.Observability.ListAlertGroupsHttp,
          Stackit.Observability.UpdateAlertGroupHttp,
          Stackit.Observability.DeleteAlertGroupHttp,
          Stackit.Observability.UpsertAlertGroupsHttp,
          Stackit.Observability.DeleteAlertGroupsHttp,
          Stackit.Observability.CreateAlertRuleHttp,
          Stackit.Observability.GetAlertRuleHttp,
          Stackit.Observability.ListAlertRulesHttp,
          Stackit.Observability.UpdateAlertRuleHttp,
          Stackit.Observability.DeleteAlertRuleHttp,
          Stackit.Observability.UpsertAlertRulesHttp,
          Stackit.Observability.DeleteAlertRulesHttp,
          Stackit.Observability.CreateAlertRecordHttp,
          Stackit.Observability.GetAlertRecordHttp,
          Stackit.Observability.ListAlertRecordsHttp,
          Stackit.Observability.UpdateAlertRecordHttp,
          Stackit.Observability.DeleteAlertRecordHttp,
          Stackit.Observability.UpsertAlertRecordsHttp,
          Stackit.Observability.DeleteAlertRecordsHttp,
        ),
        Layer.mergeAll(
          Stackit.Observability.CreateLogsAlertGroupHttp,
          Stackit.Observability.GetLogsAlertGroupHttp,
          Stackit.Observability.ListLogsAlertGroupsHttp,
          Stackit.Observability.UpdateLogsAlertGroupHttp,
          Stackit.Observability.DeleteLogsAlertGroupHttp,
          Stackit.Observability.GetAlertConfigHttp,
          Stackit.Observability.ListAlertConfigReceiversHttp,
          Stackit.Observability.GetAlertConfigReceiverHttp,
          Stackit.Observability.CreateAlertConfigReceiverHttp,
          Stackit.Observability.UpdateAlertConfigReceiverHttp,
          Stackit.Observability.DeleteAlertConfigReceiverHttp,
          Stackit.Observability.ListAlertConfigRoutesHttp,
          Stackit.Observability.GetAlertConfigRouteHttp,
          Stackit.Observability.CreateAlertConfigRouteHttp,
          Stackit.Observability.UpdateAlertConfigRouteHttp,
          Stackit.Observability.DeleteAlertConfigRouteHttp,
          Stackit.Observability.ListCertChecksHttp,
          Stackit.Observability.ListElasticsearchChecksHttp,
          Stackit.Observability.ListHttpChecksHttp,
          Stackit.Observability.ListMongoDBChecksHttp,
        ),
        Layer.mergeAll(
          Stackit.Observability.ListMySQLChecksHttp,
          Stackit.Observability.ListNetworkChecksHttp,
          Stackit.Observability.ListPingChecksHttp,
          Stackit.Observability.ListPostgreSQLChecksHttp,
          Stackit.Observability.ListRabbitMQChecksHttp,
          Stackit.Observability.ListRedisChecksHttp,
          Stackit.Observability.CreateBackupHttp,
          Stackit.Observability.ListBackupsHttp,
          Stackit.Observability.ListBackupRetentionsHttp,
          Stackit.Observability.RestoreBackupHttp,
          Stackit.Observability.CreateBackupScheduleHttp,
          Stackit.Observability.ListBackupSchedulesHttp,
          Stackit.Observability.ReadInstanceHttp,
          Stackit.Observability.WriteInstanceHttp,
          Stackit.Observability.ReadWriteInstanceHttp,
          Stackit.Observability.QueryMetricsHttp,
          Stackit.Observability.AlertsHttp,
          Stackit.Observability.PushLogsHttp,
          Stackit.Observability.QueryLogsHttp,
        ),
      ),
    ),
  ),
) {}
