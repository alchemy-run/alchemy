/**
 * Shared lifecycle of STACKIT's "Data Services" APIs (MariaDB, Valkey, and the
 * other services on the same API shape): instances bought by offering and plan,
 * configured through an open `parameters` object, with credentials as a separate
 * create-and-delete object. Not exported from any namespace barrel.
 *
 * Each service supplies a {@link DataServiceApi}, where its generated operations
 * have their typed tags handled, and keeps its own props, attributes and JSDoc.
 *
 * These APIs have no labels. A generated name holds the generation's instance id,
 * so it proves ownership; an explicit name proves nothing without state.
 */
import { Unowned } from "alchemy/AdoptPolicy";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { resolveProjectScope, type ProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp } from "./diff.ts";
import { sameMembers } from "./equal.ts";
import { isGeneratedPhysicalName } from "./names.ts";
import { waitFor, waitUntilGone } from "./wait.ts";

/** Instance create and update budget (the Go SDK's wait handlers, 45 minutes). */
const INSTANCE_TIMEOUT = "45 minutes";
/** Instance delete budget (the Go SDK's wait handler, 15 minutes). */
const INSTANCE_DELETE_TIMEOUT = "15 minutes";
/** Credential create and delete budget (the Go SDK's wait handlers, 1 minute). */
const CREDENTIAL_TIMEOUT = "1 minute";
const POLL = { interval: "5 seconds", maxInterval: "15 seconds" } as const;
/** A status read right after a PATCH can predate it. */
const SETTLE_AFTER_UPDATE = "15 seconds";
/** Polls a `failed` status may be left over from before a repairing PATCH. */
const STALE_FAILED_POLLS = 6;
/**
 * The spec gives no limit for an instance name, so a generated one stays within
 * what PostgreSQL Flex and the IaaS API accept.
 */
const MAX_NAME_LENGTH = 63;

/**
 * The 409 these APIs document on their updates operations has no documented
 * meaning, and they answer it around other work on the instance. Bounded to under
 * a minute.
 */
export const updatesConflictRetry = {
  while: (error: { readonly _tag: string }) => error._tag === "Conflict",
  schedule: Schedule.spaced("5 seconds"),
  times: 10,
} as const;

/** The requested `version` or `planName` isn't among the offerings. */
export class DataServicePlanNotFound extends Data.TaggedError("Stackit.DataServicePlanNotFound")<{
  readonly version: string;
  readonly planName: string;
  readonly available: ReadonlyArray<string>;
  readonly message: string;
}> {}

/** Another instance holds the name, and nothing proves it is ours. */
export class DataServiceNameTaken extends Data.TaggedError("Stackit.DataServiceNameTaken")<{
  readonly resourceName: string;
  readonly message: string;
}> {}

/** The API answered a credential without its connection details. */
export class DataServiceCredentialIncomplete extends Data.TaggedError(
  "Stackit.DataServiceCredentialIncomplete",
)<{
  readonly credentialId: string;
  readonly message: string;
}> {}

/** An instance, as every Data Services API returns it. */
export interface DataServiceInstance {
  readonly instanceId?: string;
  readonly name: string;
  readonly status?: string;
  readonly instanceStatus?: string;
  readonly offeringName: string;
  readonly offeringVersion: string;
  readonly planId: string;
  readonly planName: string;
  readonly parameters: unknown;
  readonly imageUrl: string;
  readonly dashboardUrl: string;
  readonly cfGuid: string;
  readonly cfSpaceGuid: string;
  readonly cfOrganizationGuid: string;
  readonly lastOperation: {
    readonly type: string;
    readonly state: string;
    readonly description: string;
  };
}

/** One offering version and its plans. */
export interface DataServiceOffering {
  readonly version: string;
  readonly plans: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

/** A service's operations, with its typed tags handled. */
export interface DataServiceApi<E, R, Params> {
  /** The instance; `undefined` on the typed not-found and gone errors. */
  getInstance: (
    scope: ProjectScope,
    instanceId: string,
  ) => Effect.Effect<DataServiceInstance | undefined, E, R>;
  listInstances: (scope: ProjectScope) => Effect.Effect<ReadonlyArray<DataServiceInstance>, E, R>;
  listOfferings: (scope: ProjectScope) => Effect.Effect<ReadonlyArray<DataServiceOffering>, E, R>;
  /** Create an instance; `undefined` on the typed `Conflict` (the name is taken). */
  createInstance: (
    scope: ProjectScope,
    request: { instanceName: string; planId: string; parameters: Params },
  ) => Effect.Effect<{ readonly instanceId: string } | undefined, E, R>;
  updateInstance: (
    scope: ProjectScope,
    instanceId: string,
    request: { planId?: string; parameters?: Params },
  ) => Effect.Effect<void, E, R>;
  /** Delete an instance; the typed not-found error counts as done. */
  deleteInstance: (scope: ProjectScope, instanceId: string) => Effect.Effect<void, E, R>;
  getAutomaticUpdates: (scope: ProjectScope, instanceId: string) => Effect.Effect<boolean, E, R>;
  setAutomaticUpdates: (
    scope: ProjectScope,
    instanceId: string,
    enabled: boolean,
  ) => Effect.Effect<void, E, R>;
  setBackupEncryptionKey: (
    scope: ProjectScope,
    instanceId: string,
    key: string | Redacted.Redacted<string>,
  ) => Effect.Effect<void, E, R>;
}

/** The props every Data Services instance has. */
export interface DataServiceInstanceProps {
  name?: string;
  version: string;
  planName: string;
  acl?: string[];
  backupEncryptionKey?: string | Redacted.Redacted<string>;
  automaticUpdates?: boolean;
  enableMonitoring?: boolean;
  monitoringInstanceId?: string;
  graphite?: string;
  metricsFrequency?: number;
  metricsPrefix?: string | Redacted.Redacted<string>;
  maxDiskThreshold?: number;
  syslog?: string[];
  projectId?: string;
  region?: string;
}

/** The attributes every Data Services instance has. */
export interface DataServiceInstanceAttributes {
  instanceId: string;
  projectId: string;
  region: string;
  name: string;
  version: string;
  planId: string;
  planName: string;
  acl: string[];
  parameters: Record<string, unknown>;
  offeringName: string;
  imageUrl: string;
  dashboardUrl: string;
  cfGuid: string;
  cfSpaceGuid: string;
  cfOrganizationGuid: string;
  status: string | undefined;
  instanceStatus: string | undefined;
  lastOperation: { type: string; state: string; description: string };
  automaticUpdates: boolean | undefined;
}

/** A password or URI from the API or the environment, always `Redacted`. */
export const toRedacted = (value: string | Redacted.Redacted<string>): Redacted.Redacted<string> =>
  typeof value === "string" ? Redacted.make(value) : value;

const reveal = <A>(value: A | Redacted.Redacted<string>): A | string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/** Drop the keys a resource doesn't set, so they stay unmanaged. */
export const definedParameters = <P extends object>(parameters: P): P =>
  Object.fromEntries(Object.entries(parameters).filter(([, value]) => value !== undefined)) as P;

/** The parameters every Data Services instance takes, from its props. */
export const commonParameters = (props: DataServiceInstanceProps) => ({
  sgw_acl: props.acl?.join(","),
  enable_monitoring: props.enableMonitoring,
  monitoring_instance_id: props.monitoringInstanceId,
  graphite: props.graphite,
  metrics_frequency: props.metricsFrequency,
  metrics_prefix: props.metricsPrefix,
  max_disk_threshold: props.maxDiskThreshold,
  syslog: props.syslog,
});

const observedParameters = (parameters: unknown): Record<string, unknown> =>
  typeof parameters === "object" && parameters !== null
    ? (parameters as Record<string, unknown>)
    : {};

/**
 * Look up a parameter in the API's answer. Parameters come back as an open object,
 * so distilled doesn't map their keys: a member whose wire name has hyphens
 * (`maxmemory_policy` on the wire is `maxmemory-policy`) has to be found under it.
 */
const observedParameter = (observed: Record<string, unknown>, key: string): unknown =>
  observed[key] ?? observed[key.replaceAll("_", "-")];

const splitAcl = (value: unknown): string[] =>
  typeof value === "string"
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "")
    : [];

const sameParameter = (key: string, observed: unknown, desired: unknown): boolean => {
  if (observed === undefined) return false;
  if (key === "sgw_acl") return sameMembers(splitAcl(observed), splitAcl(desired));
  if (Array.isArray(desired)) {
    return Array.isArray(observed) && sameMembers(observed.map(String), desired.map(String));
  }
  // The object is open, so a number can come back as a string.
  return String(observed) === String(reveal(desired));
};

/** Whether any configured parameter differs from what the instance reports. */
const parametersChanged = (observed: unknown, desired: object): boolean => {
  const current = observedParameters(observed);
  return Object.entries(desired).some(
    ([key, value]) => !sameParameter(key, observedParameter(current, key), value),
  );
};

const sameText = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const isInFlight = (instance: DataServiceInstance) =>
  instance.status === "creating" || instance.status === "updating";

/**
 * Observed parameters without `metrics_prefix`, which the spec says can hold an API
 * key. The open object can't carry a sensitive mark, so it stays out of state.
 */
const publicParameters = (parameters: unknown): Record<string, unknown> => {
  const {
    metrics_prefix: _prefix,
    "metrics-prefix": _hyphenated,
    ...rest
  } = observedParameters(parameters);
  return rest;
};

const toBaseAttributes = (
  scope: ProjectScope,
  instanceId: string,
  instance: DataServiceInstance,
  automaticUpdates: boolean | undefined,
): DataServiceInstanceAttributes => ({
  instanceId,
  projectId: scope.projectId,
  region: scope.region,
  name: instance.name,
  version: instance.offeringVersion,
  planId: instance.planId,
  planName: instance.planName,
  acl: splitAcl(observedParameter(observedParameters(instance.parameters), "sgw_acl")),
  parameters: publicParameters(instance.parameters),
  offeringName: instance.offeringName,
  imageUrl: instance.imageUrl,
  dashboardUrl: instance.dashboardUrl,
  cfGuid: instance.cfGuid,
  cfSpaceGuid: instance.cfSpaceGuid,
  cfOrganizationGuid: instance.cfOrganizationGuid,
  status: instance.status,
  instanceStatus: instance.instanceStatus,
  lastOperation: {
    type: instance.lastOperation.type,
    state: instance.lastOperation.state,
    description: instance.lastOperation.description,
  },
  automaticUpdates,
});

/** Whether a generated instance name has the shape of one Alchemy creates. */
const isGeneratedInstanceName = (name: string) => isGeneratedPhysicalName(name, MAX_NAME_LENGTH);

/**
 * The lifecycle of a Data Services instance: everything a provider's `list`, `diff`,
 * `read`, `reconcile` and `delete` do, apart from what its service adds.
 */
export const makeInstanceLifecycle = <
  E,
  R,
  Params extends object,
  Props extends DataServiceInstanceProps,
  Attrs extends DataServiceInstanceAttributes,
>(options: {
  /** What errors and logs call an instance, e.g. `STACKIT MariaDB instance`. */
  readonly label: string;
  readonly api: DataServiceApi<E, R, Params>;
  /** The configured parameters, with unset props left out. */
  readonly parametersOf: (props: Props) => Params;
  /** Add what the service keeps on top of the common attributes. */
  readonly attributes: (base: DataServiceInstanceAttributes, prior: Attrs | undefined) => Attrs;
}) => {
  const { api, label } = options;

  const generatedName = (id: string) =>
    createPhysicalName({ id, lowercase: true, maxLength: MAX_NAME_LENGTH });

  /** The instance, or `undefined` once the API reports it gone. */
  const getLive = (scope: ProjectScope, instanceId: string) =>
    api
      .getInstance(scope, instanceId)
      .pipe(
        Effect.map((instance) => (instance?.instanceStatus === "deleted" ? undefined : instance)),
      );

  /** The instance with this name. A list answers with deleted instances too. */
  const findByName = (scope: ProjectScope, name: string) =>
    api
      .listInstances(scope)
      .pipe(
        Effect.map((instances) =>
          instances.find(
            (instance) =>
              instance.name === name &&
              instance.instanceId !== undefined &&
              instance.instanceStatus !== "deleted",
          ),
        ),
      );

  /** Resolve `version` + `planName` through the offerings, as the Terraform provider does. */
  const resolvePlanId = (scope: ProjectScope, version: string, planName: string) =>
    Effect.gen(function* () {
      const offerings = yield* api.listOfferings(scope);
      const offering = offerings.find((candidate) => sameText(candidate.version, version));
      const plan = offering?.plans.find((candidate) => sameText(candidate.name, planName));
      if (plan !== undefined) return plan.id;
      const available = offerings.flatMap((candidate) =>
        candidate.plans.map((choice) => `${candidate.version}/${choice.name}`),
      );
      return yield* new DataServicePlanNotFound({
        version,
        planName,
        available,
        message:
          `${label}: no plan '${planName}' for version '${version}'. ` +
          `Available: ${available.join(", ")}`,
      });
    });

  const failureOf = (instance: DataServiceInstance) => {
    const detail = instance.lastOperation.description;
    return detail === "" ? (instance.status ?? "failed") : detail;
  };

  /**
   * Wait for `active`. Before an instance reports anything (a create that isn't
   * visible yet) the budget decides.
   */
  const waitForActive = (
    scope: ProjectScope,
    instanceId: string,
    settings: {
      readonly applied?: (instance: DataServiceInstance) => boolean;
      /** Polls to ignore `failed`: the status from before a repairing PATCH. */
      readonly staleFailed?: number;
    } = {},
  ) => {
    let staleFailed = settings.staleFailed ?? 0;
    return waitFor({
      resource: `${label} ${instanceId}`,
      read: getLive(scope, instanceId),
      ready: (instance) => instance?.status === "active" && (settings.applied?.(instance) ?? true),
      failed: (instance) => {
        if (instance === undefined) return undefined;
        if (instance.status === "deleting") return "it is being deleted";
        if (instance.status === "stopped") return "it is stopped";
        if (instance.status !== "failed") {
          staleFailed = 0;
          return undefined;
        }
        if (staleFailed > 0) {
          staleFailed--;
          return undefined;
        }
        return failureOf(instance);
      },
      state: (instance) => instance?.status ?? "not visible yet",
      timeout: INSTANCE_TIMEOUT,
      ...POLL,
    }).pipe(
      // `ready` only passes an instance.
      Effect.map((instance) => instance as DataServiceInstance),
    );
  };

  /**
   * Wait until the instance is gone. A failure counts when the delete itself failed,
   * and not when one from before this delete is still reported.
   */
  const waitForGone = (scope: ProjectScope, instanceId: string, staleFailure: boolean) =>
    waitUntilGone({
      resource: `${label} ${instanceId}`,
      read: getLive(scope, instanceId),
      state: (instance) => instance.status,
      failed: (instance) =>
        !staleFailure && instance.status === "failed" && instance.lastOperation.type === "delete"
          ? failureOf(instance)
          : undefined,
      timeout: INSTANCE_DELETE_TIMEOUT,
      ...POLL,
    });

  return {
    list: Effect.fn(function* (scope: ProjectScope) {
      const instances = yield* api.listInstances(scope);
      return instances.flatMap((instance) =>
        instance.instanceId !== undefined &&
        instance.instanceStatus !== "deleted" &&
        isGeneratedInstanceName(instance.name)
          ? [
              options.attributes(
                toBaseAttributes(scope, instance.instanceId, instance, undefined),
                undefined,
              ),
            ]
          : [],
      );
    }),

    /** `replace` for an identity change, else `undefined`. */
    diffIdentity: Effect.fn(function* (news: unknown, output: DataServiceInstanceAttributes) {
      // An explicit name can resolve to the one the old instance holds, and it can't
      // exist twice. A generated name carries the generation, so it never collides.
      if (hasUnresolvedTrigger<DataServiceInstanceProps>(news, ["name", "projectId", "region"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<DataServiceInstanceProps>(news, "name") !== undefined,
        } as const;
      }
      const scope = yield* resolveProjectScope(
        {
          projectId: rawProp<DataServiceInstanceProps>(news, "projectId") as string | undefined,
          region: rawProp<DataServiceInstanceProps>(news, "region") as string | undefined,
        },
        undefined,
      );
      // Removing `name` keeps the current one: a new name would be a new, empty
      // instance. Every change here frees the old identity, so nothing has to go first.
      const name = rawProp<DataServiceInstanceProps>(news, "name") as string | undefined;
      if (
        (name !== undefined && name !== output.name) ||
        scope.projectId !== output.projectId ||
        scope.region !== output.region
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* (input: {
      readonly id: string;
      readonly olds: Props | undefined;
      readonly output: Attrs | undefined;
      readonly previous: Attrs | undefined;
    }) {
      const { id, olds, output, previous } = input;
      const scope = yield* resolveProjectScope(olds, output);
      const toAttrs = (instanceId: string, instance: DataServiceInstance) =>
        options.attributes(
          toBaseAttributes(scope, instanceId, instance, output?.automaticUpdates),
          output,
        );
      if (output?.instanceId !== undefined) {
        const byId = yield* getLive(scope, output.instanceId);
        // A delete in flight: reconcile waits it out and creates a new one.
        if (byId?.status === "deleting") return undefined;
        if (byId !== undefined) return toAttrs(output.instanceId, byId);
      }
      const generated = yield* generatedName(id);
      const name = output?.name ?? olds?.name ?? generated;
      const found = yield* findByName(scope, name);
      if (found?.instanceId === undefined || found.status === "deleting") return undefined;
      const attrs = toAttrs(found.instanceId, found);
      // A generated name holds this generation's id, so it is ours.
      if (name === generated) return attrs;
      // The generation being replaced is ours, but only at its own scope: a name is
      // unique per project and region, so elsewhere it is someone else's.
      if (
        previous?.instanceId === found.instanceId &&
        previous.name === found.name &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region
      ) {
        return attrs;
      }
      // Without labels, nothing else proves an explicit name is ours.
      return Unowned(attrs);
    }),

    reconcile: Effect.fn(function* (input: {
      readonly id: string;
      readonly news: Props;
      readonly olds: Props | undefined;
      readonly output: Attrs | undefined;
    }) {
      const { id, news, olds, output } = input;
      const scope = yield* resolveProjectScope(news, output);
      const generated = yield* generatedName(id);
      const name = news.name ?? output?.name ?? generated;
      const parameters = options.parametersOf(news);

      // 1. Observe — `output` is a cache for the id, and only names the desired
      // instance in the same project and region. Without it, only this generation's
      // generated name can be claimed; `read` already reported an explicit one.
      let instanceId: string | undefined;
      let current: DataServiceInstance | undefined;
      if (
        output?.instanceId !== undefined &&
        output.projectId === scope.projectId &&
        output.region === scope.region
      ) {
        current = yield* getLive(scope, output.instanceId);
        instanceId = current === undefined ? undefined : output.instanceId;
      }
      if (current === undefined && name === generated) {
        current = yield* findByName(scope, name);
        instanceId = current?.instanceId;
      }
      // A delete in flight (an interrupted destroy): let it finish.
      if (current?.status === "deleting" && instanceId !== undefined) {
        yield* waitForGone(scope, instanceId, false);
        current = undefined;
      }
      // A change in flight settles first. A `failed` result stays in the running: the
      // sync below may repair it.
      if (current !== undefined && instanceId !== undefined && isInFlight(current)) {
        current = yield* waitFor({
          resource: `${label} ${instanceId}`,
          read: getLive(scope, instanceId),
          ready: (instance) => instance === undefined || !isInFlight(instance),
          state: (instance) => instance?.status,
          timeout: INSTANCE_TIMEOUT,
          ...POLL,
        });
      }

      // 2. Ensure — a conflict on a generated name is a race we lost to ourselves.
      // On an explicit name it is someone else's instance.
      if (current === undefined || instanceId === undefined) {
        const planId = yield* resolvePlanId(scope, news.version, news.planName);
        const created = yield* api.createInstance(scope, {
          instanceName: name,
          planId,
          parameters,
        });
        const createdId =
          created?.instanceId ??
          (name === generated ? (yield* findByName(scope, name))?.instanceId : undefined);
        if (createdId === undefined) {
          return yield* new DataServiceNameTaken({
            resourceName: name,
            message: `${label} name '${name}' is already taken in project ${scope.projectId}.`,
          });
        }
        instanceId = createdId;
        current = yield* waitForActive(scope, createdId);
      }
      const liveId = instanceId;

      // 3. Sync — one PATCH for the plan and parameters, against what is observed. It
      // sends every configured parameter, and what the props leave out stays as it is.
      const planChanged =
        !sameText(current.offeringVersion, news.version) ||
        !sameText(current.planName, news.planName);
      const hasParameters = Object.keys(parameters).length > 0;
      if (planChanged || (hasParameters && parametersChanged(current.parameters, parameters))) {
        const planId = planChanged
          ? yield* resolvePlanId(scope, news.version, news.planName)
          : undefined;
        const repairing = current.status === "failed";
        yield* api.updateInstance(scope, liveId, {
          ...(planId !== undefined ? { planId } : {}),
          ...(hasParameters ? { parameters } : {}),
        });
        yield* Effect.sleep(SETTLE_AFTER_UPDATE);
        // Parameters aren't awaited: the API may normalize what it echoes back, and a
        // value that never matches must not stall the deploy for the whole budget.
        current = yield* waitForActive(scope, liveId, {
          applied: (instance) => planId === undefined || instance.planId === planId,
          staleFailed: repairing ? STALE_FAILED_POLLS : 0,
        });
      } else if (current.status !== "active") {
        current = yield* waitForActive(scope, liveId);
      }

      let automaticUpdates = output?.automaticUpdates;
      if (news.automaticUpdates !== undefined) {
        const observed = yield* api.getAutomaticUpdates(scope, liveId);
        if (observed !== news.automaticUpdates) {
          yield* api.setAutomaticUpdates(scope, liveId, news.automaticUpdates);
        }
        automaticUpdates = news.automaticUpdates;
      }

      // The API can't read the key back, so the previous props are all there is.
      if (
        news.backupEncryptionKey !== undefined &&
        reveal(news.backupEncryptionKey) !== reveal(olds?.backupEncryptionKey)
      ) {
        yield* api.setBackupEncryptionKey(scope, liveId, news.backupEncryptionKey);
      }

      // 4. Return
      const final = (yield* getLive(scope, liveId)) ?? current;
      return options.attributes(toBaseAttributes(scope, liveId, final, automaticUpdates), output);
    }),

    delete: Effect.fn(function* (output: DataServiceInstanceAttributes) {
      const scope = { projectId: output.projectId, region: output.region };
      const { instanceId } = output;
      let current = yield* getLive(scope, instanceId);
      if (current === undefined) return;
      if (current.status === "deleting") return yield* waitForGone(scope, instanceId, true);
      // A change in flight (an interrupted deploy) settles first, in whatever state.
      if (isInFlight(current)) {
        current = yield* waitFor({
          resource: `${label} ${instanceId}`,
          read: getLive(scope, instanceId),
          ready: (instance) => instance === undefined || !isInFlight(instance),
          state: (instance) => instance?.status,
          timeout: INSTANCE_TIMEOUT,
          ...POLL,
        });
        if (current === undefined) return;
      }
      const staleFailure = current.status === "failed";
      yield* api.deleteInstance(scope, instanceId);
      yield* waitForGone(scope, instanceId, staleFailure);
    }),
  };
};

/** Props every Data Services credential has. */
export interface DataServiceCredentialProps {
  instanceId: string;
  rotationKey?: string;
  projectId?: string;
  region?: string;
}

/** What a credential's lifecycle needs of its attributes. */
export interface DataServiceCredentialIdentity {
  credentialId: string;
  instanceId: string;
  projectId: string;
  region: string;
}

/** A service's credential operations, with its typed tags handled. */
export interface DataServiceCredentialApi<E, R, Response extends { readonly id: string }> {
  /** The credential; `undefined` on the typed not-found and gone errors. */
  getCredential: (
    scope: ProjectScope,
    instanceId: string,
    credentialId: string,
  ) => Effect.Effect<Response | undefined, E, R>;
  createCredential: (scope: ProjectScope, instanceId: string) => Effect.Effect<Response, E, R>;
  /** Delete a credential; the typed not-found error counts as done. */
  deleteCredential: (
    scope: ProjectScope,
    instanceId: string,
    credentialId: string,
  ) => Effect.Effect<void, E, R>;
}

/** Wait until a just-created credential answers: the first reads are 404s. */
export const waitForCredential = <E, R, Response extends { readonly id: string }>(
  api: DataServiceCredentialApi<E, R, Response>,
  label: string,
  scope: ProjectScope,
  instanceId: string,
  credentialId: string,
) =>
  waitFor({
    resource: `${label} ${credentialId}`,
    read: api.getCredential(scope, instanceId, credentialId),
    ready: (credential) => credential !== undefined,
    state: (credential) => (credential === undefined ? "not visible yet" : "ready"),
    timeout: CREDENTIAL_TIMEOUT,
  }).pipe(
    // `ready` only passes a credential.
    Effect.map((credential) => credential as Response),
  );

/** The lifecycle of a Data Services credential, which has nothing to update. */
export const makeCredentialLifecycle = <
  E,
  R,
  Response extends { readonly id: string },
  Attrs extends DataServiceCredentialIdentity,
>(options: {
  /** What errors and logs call a credential, e.g. `STACKIT MariaDB credential`. */
  readonly label: string;
  readonly api: DataServiceCredentialApi<E, R, Response>;
  /** The attributes; `undefined` when the answer has no connection details. */
  readonly attributes: (
    scope: ProjectScope,
    instanceId: string,
    credential: Response,
  ) => Attrs | undefined;
}) => {
  const { api, label } = options;

  const toAttrs = (scope: ProjectScope, instanceId: string, credential: Response) => {
    const attrs = options.attributes(scope, instanceId, credential);
    return attrs === undefined
      ? Effect.fail(
          new DataServiceCredentialIncomplete({
            credentialId: credential.id,
            message: `${label} ${credential.id} came back without its connection details.`,
          }),
        )
      : Effect.succeed(attrs);
  };

  return {
    diff: Effect.fn(function* (
      news: unknown,
      olds: DataServiceCredentialProps | undefined,
      output: DataServiceCredentialIdentity,
    ) {
      // A credential has no name, so a new one never collides with the old one.
      if (
        hasUnresolvedTrigger<DataServiceCredentialProps>(news, [
          "instanceId",
          "rotationKey",
          "projectId",
          "region",
        ])
      ) {
        return { action: "replace" } as const;
      }
      const scope = yield* resolveProjectScope(
        {
          projectId: rawProp<DataServiceCredentialProps>(news, "projectId") as string | undefined,
          region: rawProp<DataServiceCredentialProps>(news, "region") as string | undefined,
        },
        undefined,
      );
      if (
        rawProp<DataServiceCredentialProps>(news, "instanceId") !== output.instanceId ||
        scope.projectId !== output.projectId ||
        scope.region !== output.region ||
        (olds !== undefined &&
          rawProp<DataServiceCredentialProps>(news, "rotationKey") !== olds.rotationKey)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* (output: Attrs | undefined) {
      // No name, no labels: only the id in state can find a credential.
      if (output === undefined) return undefined;
      const scope = { projectId: output.projectId, region: output.region };
      const found = yield* api.getCredential(scope, output.instanceId, output.credentialId);
      return found === undefined ? undefined : yield* toAttrs(scope, output.instanceId, found);
    }),

    reconcile: Effect.fn(function* (news: DataServiceCredentialProps, output: Attrs | undefined) {
      const scope = yield* resolveProjectScope(news, output);
      const { instanceId } = news;
      // 1. Observe — `output` only names the credential on the same instance.
      const current =
        output !== undefined &&
        output.instanceId === instanceId &&
        output.projectId === scope.projectId &&
        output.region === scope.region
          ? yield* api.getCredential(scope, instanceId, output.credentialId)
          : undefined;
      if (current !== undefined) return yield* toAttrs(scope, instanceId, current);
      // 2. Ensure. There is nothing to sync: a credential has no update.
      const created = yield* api.createCredential(scope, instanceId);
      // A failure from here on would lose the only id that can delete it, and every retried
      // deploy would leave another live login on the instance.
      return yield* waitForCredential(api, label, scope, instanceId, created.id).pipe(
        Effect.flatMap((visible) => toAttrs(scope, instanceId, visible)),
        Effect.onError(() =>
          api.deleteCredential(scope, instanceId, created.id).pipe(Effect.ignore),
        ),
      );
    }),

    delete: Effect.fn(function* (output: DataServiceCredentialIdentity) {
      const scope = { projectId: output.projectId, region: output.region };
      const { instanceId, credentialId } = output;
      const current = yield* api.getCredential(scope, instanceId, credentialId);
      if (current === undefined) return;
      yield* api.deleteCredential(scope, instanceId, credentialId);
      yield* waitUntilGone({
        resource: `${label} ${credentialId}`,
        read: api.getCredential(scope, instanceId, credentialId),
        timeout: CREDENTIAL_TIMEOUT,
      });
    }),
  };
};
