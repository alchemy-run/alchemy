import {
  LokiCredentials,
  ObservabilityDataCredentials,
  observabilityDataCredentialsOf,
} from "@distilled.cloud/stackit/Credentials";
import * as loki from "@distilled.cloud/stackit/logs_loki";
import * as observability from "@distilled.cloud/stackit/observability";
import * as alertmanager from "@distilled.cloud/stackit/observability_alertmanager";
import * as prometheus from "@distilled.cloud/stackit/observability_prometheus";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as Redacted from "effect/Redacted";
import * as StackitBindings from "../StackitBindings.ts";
import type { AlertsClient } from "./Alerts.ts";
import type { Credential } from "./Credential.ts";
import type { Instance } from "./Instance.ts";
import { asRedacted } from "./internal.ts";
import type { QueryLogsClient } from "./QueryLogs.ts";
import type { QueryMetricsClient } from "./QueryMetrics.ts";
import type { ReadInstanceClient } from "./ReadInstance.ts";
import type { ReadWriteInstanceClient } from "./ReadWriteInstance.ts";
import type { WriteInstanceClient } from "./WriteInstance.ts";

/**
 * Shared HTTP scaffolding for Observability bindings.
 * NOT exported from index.ts.
 *
 * Roles bind on the project holding the instance: STACKIT has no role binding on a
 * single instance (see `StackitBindings`). The permissions come from the spec's
 * `x-stackit-authorization` on each operation, which still call the product Argus:
 *
 * - every read inside an instance is `argus.instance.get`;
 * - every write inside an instance, including creating and deleting scrape jobs,
 *   alert groups and rules, is `argus.instance.update`;
 * - `listInstances` is `argus.instance.list`, `listPlans` and `listOfferings` are
 *   `argus.plan.list`.
 *
 * `argus.instance.update` is the only write permission the API has, so a binding that
 * writes one rule can write the whole instance's configuration. The grant applies to
 * every instance in the project.
 */
export const INSTANCE_READ_ACCESS: StackitBindings.Access = {
  permissions: ["argus.instance.get"],
};
export const INSTANCE_WRITE_ACCESS: StackitBindings.Access = {
  permissions: ["argus.instance.update"],
};
export const INSTANCE_LIST_ACCESS: StackitBindings.Access = {
  permissions: ["argus.instance.list"],
};
export const INSTANCE_READ_WRITE_ACCESS: StackitBindings.Access = {
  permissions: ["argus.instance.get", "argus.instance.update"],
};
export const PLAN_LIST_ACCESS: StackitBindings.Access = { permissions: ["argus.plan.list"] };

interface HttpBindingOptions<I, A, E> {
  /** Fully-qualified binding tag, e.g. `Stackit.Observability.GetInstance`. */
  tag: string;
  /** What the operation needs on the project holding the instance. */
  access: StackitBindings.Access;
  /** The distilled operation; the bound resource's identifiers are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}

/** A binding over an operation on an instance: the project and instance id are injected. */
export const makeInstanceHttpBinding = <I extends { projectId: string; instanceId: string }, A, E>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (instance: Instance) => ({
      projectId: instance.projectId,
      instanceId: instance.instanceId,
    }),
    grants: (instance) => [StackitBindings.grantOn(instance, options.access)],
  });

/** A binding over an operation on a project, through an instance in it: `listInstances`, `listPlans`. */
export const makeProjectHttpBinding = <I extends { projectId: string }, A, E>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (instance: Instance) => ({ projectId: instance.projectId }),
    grants: (instance) => [StackitBindings.grantOn(instance, options.access)],
  });

/** A binding over an operation on a credential: its project, instance and username are injected. */
export const makeCredentialHttpBinding = <
  I extends { projectId: string; instanceId: string; username: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (credential: Credential) => ({
      projectId: credential.projectId,
      instanceId: credential.instanceId,
      username: credential.username,
    }),
    grants: (credential) => [StackitBindings.grantOn(credential, options.access)],
  });

/** A bound instance's identifiers, read when a call runs. */
export interface InstanceIdentifiers {
  readonly projectId: Effect.Effect<string>;
  readonly instanceId: Effect.Effect<string>;
}

type InstanceRequest<I> = Omit<I, "projectId" | "instanceId">;

/** Inject the instance's identifiers into every request of an operation. */
const onInstance =
  (instance: InstanceIdentifiers) =>
  <I extends { projectId: string; instanceId: string }, A, E>(
    run: (input: I) => Effect.Effect<A, E>,
  ) =>
    Effect.fnUntraced(function* (request?: InstanceRequest<I>) {
      const projectId = yield* instance.projectId;
      const instanceId = yield* instance.instanceId;
      // The compiler can't prove `Omit<I, K>` plus the `K` fields is `I`.
      return yield* run({ ...request, projectId, instanceId } as unknown as I);
    });

/**
 * Build the read client for an instance. Its operations are resolved with the
 * host's credentials once, when the layer is built.
 */
export const makeReadInstanceClient = Effect.gen(function* () {
  const getInstance = yield* StackitBindings.withCredentials(observability.getInstance);
  const listACL = yield* StackitBindings.withCredentials(observability.listACL);
  const getGrafanaConfigs = yield* StackitBindings.withCredentials(observability.getGrafanaConfigs);
  const getMetricsStorageRetention = yield* StackitBindings.withCredentials(
    observability.getMetricsStorageRetention,
  );
  const getLogsConfigs = yield* StackitBindings.withCredentials(observability.getLogsConfigs);
  const getTracesConfigs = yield* StackitBindings.withCredentials(observability.getTracesConfigs);
  const listCredentials = yield* StackitBindings.withCredentials(observability.listCredentials);
  const getCredentialsRemoteWriteConfig = yield* StackitBindings.withCredentials(
    observability.getCredentialsRemoteWriteConfig,
  );
  const getScrapeConfig = yield* StackitBindings.withCredentials(observability.getScrapeConfig);
  const listScrapeConfigs = yield* StackitBindings.withCredentials(observability.listScrapeConfigs);
  const getAlertGroup = yield* StackitBindings.withCredentials(observability.getAlertgroup);
  const listAlertGroups = yield* StackitBindings.withCredentials(observability.listAlertgroups);
  const getAlertRule = yield* StackitBindings.withCredentials(observability.getAlertrule);
  const listAlertRules = yield* StackitBindings.withCredentials(observability.listAlertrules);
  const getAlertRecord = yield* StackitBindings.withCredentials(observability.getAlertRecord);
  const listAlertRecords = yield* StackitBindings.withCredentials(observability.listAlertRecords);
  const getLogsAlertGroup = yield* StackitBindings.withCredentials(observability.getLogsAlertgroup);
  const listLogsAlertGroups = yield* StackitBindings.withCredentials(
    observability.listLogsAlertgroups,
  );
  const getAlertConfig = yield* StackitBindings.withCredentials(observability.getAlertConfigs);
  const listAlertConfigReceivers = yield* StackitBindings.withCredentials(
    observability.listAlertConfigReceivers,
  );
  const getAlertConfigReceiver = yield* StackitBindings.withCredentials(
    observability.getAlertConfigReceiver,
  );
  const listAlertConfigRoutes = yield* StackitBindings.withCredentials(
    observability.listAlertConfigRoutes,
  );
  const getAlertConfigRoute = yield* StackitBindings.withCredentials(
    observability.getAlertConfigRoute,
  );
  const listCertChecks = yield* StackitBindings.withCredentials(observability.listCertChecks);
  const listElasticsearchChecks = yield* StackitBindings.withCredentials(
    observability.listElasticsearchChecks,
  );
  const listHttpChecks = yield* StackitBindings.withCredentials(observability.listHttpChecks);
  const listMongoDBChecks = yield* StackitBindings.withCredentials(observability.listMongodbChecks);
  const listMySQLChecks = yield* StackitBindings.withCredentials(observability.listMysqlChecks);
  const listNetworkChecks = yield* StackitBindings.withCredentials(observability.listNetworkChecks);
  const listPingChecks = yield* StackitBindings.withCredentials(observability.listPingChecks);
  const listPostgreSQLChecks = yield* StackitBindings.withCredentials(
    observability.listPostgresqlChecks,
  );
  const listRabbitMQChecks = yield* StackitBindings.withCredentials(
    observability.listRabbitmqChecks,
  );
  const listRedisChecks = yield* StackitBindings.withCredentials(observability.listRedisChecks);
  const listBackups = yield* StackitBindings.withCredentials(observability.listBackups);
  const listBackupRetentions = yield* StackitBindings.withCredentials(
    observability.listBackupRetentions,
  );
  const listBackupSchedules = yield* StackitBindings.withCredentials(
    observability.listBackupSchedules,
  );
  return (instance: InstanceIdentifiers): ReadInstanceClient => {
    const on = onInstance(instance);
    return {
      getInstance: on(getInstance),
      listACL: on(listACL),
      getGrafanaConfigs: on(getGrafanaConfigs),
      getMetricsStorageRetention: on(getMetricsStorageRetention),
      getLogsConfigs: on(getLogsConfigs),
      getTracesConfigs: on(getTracesConfigs),
      listCredentials: on(listCredentials),
      getCredentialsRemoteWriteConfig: on(getCredentialsRemoteWriteConfig),
      getScrapeConfig: on(getScrapeConfig),
      listScrapeConfigs: on(listScrapeConfigs),
      getAlertGroup: on(getAlertGroup),
      listAlertGroups: on(listAlertGroups),
      getAlertRule: on(getAlertRule),
      listAlertRules: on(listAlertRules),
      getAlertRecord: on(getAlertRecord),
      listAlertRecords: on(listAlertRecords),
      getLogsAlertGroup: on(getLogsAlertGroup),
      listLogsAlertGroups: on(listLogsAlertGroups),
      getAlertConfig: on(getAlertConfig),
      listAlertConfigReceivers: on(listAlertConfigReceivers),
      getAlertConfigReceiver: on(getAlertConfigReceiver),
      listAlertConfigRoutes: on(listAlertConfigRoutes),
      getAlertConfigRoute: on(getAlertConfigRoute),
      listCertChecks: on(listCertChecks),
      listElasticsearchChecks: on(listElasticsearchChecks),
      listHttpChecks: on(listHttpChecks),
      listMongoDBChecks: on(listMongoDBChecks),
      listMySQLChecks: on(listMySQLChecks),
      listNetworkChecks: on(listNetworkChecks),
      listPingChecks: on(listPingChecks),
      listPostgreSQLChecks: on(listPostgreSQLChecks),
      listRabbitMQChecks: on(listRabbitMQChecks),
      listRedisChecks: on(listRedisChecks),
      listBackups: on(listBackups),
      listBackupRetentions: on(listBackupRetentions),
      listBackupSchedules: on(listBackupSchedules),
    };
  };
});

/**
 * Build the write client for an instance. Its operations are resolved with the
 * host's credentials once, when the layer is built.
 */
export const makeWriteInstanceClient = Effect.gen(function* () {
  const updateCredentialsRemoteWriteConfig = yield* StackitBindings.withCredentials(
    observability.updateCredentialsRemoteWriteConfig,
  );
  const createScrapeConfig = yield* StackitBindings.withCredentials(
    observability.createScrapeConfig,
  );
  const updateScrapeConfig = yield* StackitBindings.withCredentials(
    observability.updateScrapeConfig,
  );
  const deleteScrapeConfig = yield* StackitBindings.withCredentials(
    observability.deleteScrapeConfig,
  );
  const upsertScrapeConfigs = yield* StackitBindings.withCredentials(
    observability.partialUpdateScrapeConfigs,
  );
  const deleteScrapeConfigs = yield* StackitBindings.withCredentials(
    observability.deleteScrapeConfigs,
  );
  const createAlertGroup = yield* StackitBindings.withCredentials(observability.createAlertgroups);
  const updateAlertGroup = yield* StackitBindings.withCredentials(observability.updateAlertgroup);
  const deleteAlertGroup = yield* StackitBindings.withCredentials(observability.deleteAlertgroup);
  const upsertAlertGroups = yield* StackitBindings.withCredentials(
    observability.partialUpdateAlertgroups,
  );
  const deleteAlertGroups = yield* StackitBindings.withCredentials(observability.deleteAlertgroups);
  const createAlertRule = yield* StackitBindings.withCredentials(observability.createAlertrules);
  const updateAlertRule = yield* StackitBindings.withCredentials(observability.updateAlertrule);
  const deleteAlertRule = yield* StackitBindings.withCredentials(observability.deleteAlertrule);
  const upsertAlertRules = yield* StackitBindings.withCredentials(
    observability.partialUpdateAlertrules,
  );
  const deleteAlertRules = yield* StackitBindings.withCredentials(observability.deleteAlertrules);
  const createAlertRecord = yield* StackitBindings.withCredentials(observability.createAlertRecord);
  const updateAlertRecord = yield* StackitBindings.withCredentials(observability.updateAlertRecord);
  const deleteAlertRecord = yield* StackitBindings.withCredentials(observability.deleteAlertRecord);
  const upsertAlertRecords = yield* StackitBindings.withCredentials(
    observability.partialUpdateAlertRecords,
  );
  const deleteAlertRecords = yield* StackitBindings.withCredentials(
    observability.deleteAlertRecords,
  );
  const createLogsAlertGroup = yield* StackitBindings.withCredentials(
    observability.createLogsAlertgroups,
  );
  const updateLogsAlertGroup = yield* StackitBindings.withCredentials(
    observability.updateLogsAlertgroup,
  );
  const deleteLogsAlertGroup = yield* StackitBindings.withCredentials(
    observability.deleteLogsAlertgroup,
  );
  const createAlertConfigReceiver = yield* StackitBindings.withCredentials(
    observability.createAlertConfigReceiver,
  );
  const updateAlertConfigReceiver = yield* StackitBindings.withCredentials(
    observability.updateAlertConfigReceiver,
  );
  const deleteAlertConfigReceiver = yield* StackitBindings.withCredentials(
    observability.deleteAlertConfigReceiver,
  );
  const createAlertConfigRoute = yield* StackitBindings.withCredentials(
    observability.createAlertConfigRoute,
  );
  const updateAlertConfigRoute = yield* StackitBindings.withCredentials(
    observability.updateAlertConfigRoute,
  );
  const deleteAlertConfigRoute = yield* StackitBindings.withCredentials(
    observability.deleteAlertConfigRoute,
  );
  const createBackup = yield* StackitBindings.withCredentials(observability.createBackup);
  const restoreBackup = yield* StackitBindings.withCredentials(observability.restoreBackup);
  const createBackupSchedule = yield* StackitBindings.withCredentials(
    observability.createBackupSchedule,
  );
  return (instance: InstanceIdentifiers): WriteInstanceClient => {
    const on = onInstance(instance);
    return {
      updateCredentialsRemoteWriteConfig: on(updateCredentialsRemoteWriteConfig),
      createScrapeConfig: on(createScrapeConfig),
      updateScrapeConfig: on(updateScrapeConfig),
      deleteScrapeConfig: on(deleteScrapeConfig),
      upsertScrapeConfigs: on(upsertScrapeConfigs),
      deleteScrapeConfigs: on(deleteScrapeConfigs),
      createAlertGroup: on(createAlertGroup),
      updateAlertGroup: on(updateAlertGroup),
      deleteAlertGroup: on(deleteAlertGroup),
      upsertAlertGroups: on(upsertAlertGroups),
      deleteAlertGroups: on(deleteAlertGroups),
      createAlertRule: on(createAlertRule),
      updateAlertRule: on(updateAlertRule),
      deleteAlertRule: on(deleteAlertRule),
      upsertAlertRules: on(upsertAlertRules),
      deleteAlertRules: on(deleteAlertRules),
      createAlertRecord: on(createAlertRecord),
      updateAlertRecord: on(updateAlertRecord),
      deleteAlertRecord: on(deleteAlertRecord),
      upsertAlertRecords: on(upsertAlertRecords),
      deleteAlertRecords: on(deleteAlertRecords),
      createLogsAlertGroup: on(createLogsAlertGroup),
      updateLogsAlertGroup: on(updateLogsAlertGroup),
      deleteLogsAlertGroup: on(deleteLogsAlertGroup),
      createAlertConfigReceiver: on(createAlertConfigReceiver),
      updateAlertConfigReceiver: on(updateAlertConfigReceiver),
      deleteAlertConfigReceiver: on(deleteAlertConfigReceiver),
      createAlertConfigRoute: on(createAlertConfigRoute),
      updateAlertConfigRoute: on(updateAlertConfigRoute),
      deleteAlertConfigRoute: on(deleteAlertConfigRoute),
      createBackup: on(createBackup),
      restoreBackup: on(restoreBackup),
      createBackupSchedule: on(createBackupSchedule),
    };
  };
});

/** Build the client with every read and write operation on an instance. */
export const makeReadWriteInstanceClient = Effect.gen(function* () {
  const makeRead = yield* makeReadInstanceClient;
  const makeWrite = yield* makeWriteInstanceClient;
  return (instance: InstanceIdentifiers): ReadWriteInstanceClient => ({
    ...makeRead(instance),
    ...makeWrite(instance),
  });
});

/**
 * Build a binding whose client groups several operations on an instance: one grant for
 * the access level, then the client for the bound instance.
 */
export const makeInstanceClientHttpBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.Observability.ReadInstance`. */
  tag: string;
  /** What the client needs on the project holding the instance. */
  access: StackitBindings.Access;
  /** Build the client; resolved when the layer is built. */
  makeClient: Effect.Effect<(instance: InstanceIdentifiers) => Client>;
}) =>
  Effect.gen(function* () {
    const bind = yield* StackitBindings.Bind;
    const makeClient = yield* options.makeClient;
    return Effect.fn(function* (instance: Instance) {
      const projectId = yield* instance.projectId;
      const instanceId = yield* instance.instanceId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${instance})`({
          grants: [StackitBindings.grantOn(instance, options.access)],
        });
      }
      return makeClient({ projectId, instanceId });
    });
  });

/**
 * Where a host reads what the instance's own APIs take, once its bundle runs. These are
 * not STACKIT APIs: they sign with a credential of the instance, so they grant no role and
 * create no service account. A value can reach the host unwrapped, whatever its type says.
 */
interface DataAccess {
  readonly url: Effect.Effect<string>;
  readonly username: Effect.Effect<string>;
  readonly password: Effect.Effect<string | Redacted.Redacted<string> | undefined>;
}

const credentialsOf = (access: DataAccess) =>
  Effect.gen(function* () {
    const url = yield* access.url;
    const username = yield* access.username;
    const password = yield* access.password;
    return observabilityDataCredentialsOf({ url, username, password: asRedacted(password) });
  });

/** Calls an operation with a bound credential on the Prometheus or Alertmanager API. */
export interface DataCaller {
  <I, A, E>(
    operation: (input: I) => Effect.Effect<A, E, alertmanager.ObservabilityDataOpContext>,
    request: I,
  ): Effect.Effect<A, E>;
}

/** Calls an operation with a bound credential on the Loki API. */
export interface LokiCaller {
  <I, A, E>(
    operation: (input: I) => Effect.Effect<A, E, loki.LokiOpContext>,
    request: I,
  ): Effect.Effect<A, E>;
}

/** Each request acquires what it needs, so nothing outlives a request on a host like workerd. */
const makeDataCaller =
  (access: DataAccess): DataCaller =>
  (operation, request) =>
    Effect.gen(function* () {
      const credentials = yield* credentialsOf(access);
      return yield* operation(request).pipe(
        Effect.provideService(ObservabilityDataCredentials, credentials),
        Effect.provide(FetchHttpClient.layer),
      );
    });

/** Each request acquires what it needs, so nothing outlives a request on a host like workerd. */
const makeLokiCaller =
  (access: DataAccess): LokiCaller =>
  (operation, request) =>
    Effect.gen(function* () {
      const credentials = yield* credentialsOf(access);
      return yield* operation(request).pipe(
        Effect.provideService(LokiCredentials, credentials),
        Effect.provide(FetchHttpClient.layer),
      );
    });

/** Build a binding over a client of one of the instance's own APIs. */
const makeDataBinding = <Caller, Client>(
  urlOf: (instance: Instance) => Instance["metricsUrl"],
  makeCaller: (access: DataAccess) => Caller,
  makeClient: (call: Caller) => Client,
) =>
  Effect.fn(function* (instance: Instance, credential: Credential) {
    const url = yield* urlOf(instance);
    const username = yield* credential.username;
    const password = yield* credential.password;
    return makeClient(makeCaller({ url, username, password }));
  });

/** A binding on the instance's Prometheus API. */
export const makeMetricsBinding = <Client>(makeClient: (call: DataCaller) => Client) =>
  makeDataBinding((instance) => instance.metricsUrl, makeDataCaller, makeClient);

/** A binding on the instance's Alertmanager API. */
export const makeAlertingBinding = <Client>(makeClient: (call: DataCaller) => Client) =>
  makeDataBinding((instance) => instance.alertingUrl, makeDataCaller, makeClient);

/** A binding on the push half of the instance's Loki API. */
export const makeLogsPushBinding = <Client>(makeClient: (call: LokiCaller) => Client) =>
  makeDataBinding((instance) => instance.logsPushUrl, makeLokiCaller, makeClient);

/** A binding on the query half of the instance's Loki API. */
export const makeLogsQueryBinding = <Client>(makeClient: (call: LokiCaller) => Client) =>
  makeDataBinding((instance) => instance.logsUrl, makeLokiCaller, makeClient);

/** Build the client of the Prometheus query API. `match[]` is `match` on the client. */
export const makeQueryMetricsClient = (call: DataCaller): QueryMetricsClient => ({
  query: (request) => call(prometheus.query, request),
  queryRange: (request) => call(prometheus.queryRange, request),
  labels: (input) => {
    const { match, ...request } = input ?? {};
    return call(prometheus.labels, { ...request, match__: match });
  },
  labelValues: ({ match, ...request }) =>
    call(prometheus.labelValues, { ...request, match__: match }),
  series: ({ match, ...request }) => call(prometheus.series, { ...request, match__: match }),
});

/** Build the client of the Alertmanager API. */
export const makeAlertsClient = (call: DataCaller): AlertsClient => ({
  getStatus: () => call(alertmanager.getStatus, {}),
  getReceivers: () => call(alertmanager.getReceivers, {}),
  getAlerts: (request = {}) => call(alertmanager.getAlerts, request),
  getAlertGroups: (request = {}) => call(alertmanager.getAlertGroups, request),
  createAlerts: (request) => call(alertmanager.createAlert, request),
  getSilences: (request = {}) => call(alertmanager.getSilences, request),
  getSilence: (request) => call(alertmanager.getSilence, request),
  createSilence: (request) => call(alertmanager.createSilence, request),
  deleteSilence: (request) => call(alertmanager.deleteSilence, request),
});

/** Build the client of the Loki query API. */
export const makeQueryLogsClient = (call: LokiCaller): QueryLogsClient => ({
  query: (request) => call(loki.query, request),
  queryRange: (request) => call(loki.queryRange, request),
});
