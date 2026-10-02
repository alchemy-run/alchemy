import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { waitForProvisioned } from "../Arm.ts";
import { lower, secretFingerprint } from "./common.ts";

/**
 * Converge a singleton SQL setting (a policy that always exists on its
 * parent): observe it, write only when it drifts from the desired state
 * (or `force` is set, e.g. for a write-only secret), then wait until the
 * write is visible. SQL setting writes are often asynchronous and keep
 * reporting the old values for a while.
 */
/**
 * Retry a SQL write while a previous asynchronous write to the same
 * setting is still running (`SqlOperationInProgress`).
 */
export const retryInProgress = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
) =>
  self.pipe(
    Effect.retry({
      while: (e) => e._tag === "SqlOperationInProgress",
      schedule: Schedule.spaced("5 seconds"),
      times: 36,
    }),
  );

export const syncSetting = <
  A,
  E1,
  R1,
  E2 extends { readonly _tag: string },
  R2,
>(options: {
  label: string;
  get: Effect.Effect<A | undefined, E1, R1>;
  converged: (observed: A) => boolean;
  /**
   * What must be observable before the write counts as applied (default:
   * `converged`). For fields Azure accepts but does not report back yet.
   */
  visible?: (observed: A) => boolean;
  put: Effect.Effect<unknown, E2, R2>;
  force?: boolean;
  times?: number;
}) =>
  Effect.gen(function* () {
    const observed = yield* options.get;
    if (
      options.force === true ||
      observed === undefined ||
      !options.converged(observed)
    ) {
      yield* retryInProgress(options.put);
    }
    return yield* waitForProvisioned(
      options.label,
      options.get,
      (value) =>
        (options.visible ?? options.converged)(value)
          ? "Succeeded"
          : "Updating",
      { interval: "3 seconds", times: options.times ?? 60 },
    );
  });

/** Order-insensitive, case-insensitive comparison of string lists. */
export const sameList = (
  observed: readonly string[] | undefined,
  desired: readonly string[] | undefined,
) =>
  desired === undefined ||
  JSON.stringify([...(observed ?? [])].map((v) => lower(v)).sort()) ===
    JSON.stringify([...desired].map((v) => lower(v)).sort());

/** Location of a server-level setting or child. */
export interface ServerScope {
  resourceGroup: string;
  serverName: string;
}

/** Location of a database-level setting or child. */
export interface DatabaseScope extends ServerScope {
  databaseName: string;
}

/** Location of a managed-instance-level setting or child. */
export interface InstanceScope {
  resourceGroup: string;
  managedInstanceName: string;
}

/** Location of a managed-database-level setting or child. */
export interface ManagedDatabaseScope extends InstanceScope {
  databaseName: string;
}

export const serverPath = (subscriptionId: string, s: ServerScope) => ({
  subscriptionId,
  resourceGroupName: s.resourceGroup,
  serverName: s.serverName,
});

export const databasePath = (subscriptionId: string, s: DatabaseScope) => ({
  subscriptionId,
  resourceGroupName: s.resourceGroup,
  serverName: s.serverName,
  databaseName: s.databaseName,
});

export const instancePath = (subscriptionId: string, s: InstanceScope) => ({
  subscriptionId,
  resourceGroupName: s.resourceGroup,
  managedInstanceName: s.managedInstanceName,
});

export const managedDatabasePath = (
  subscriptionId: string,
  s: ManagedDatabaseScope,
) => ({
  subscriptionId,
  resourceGroupName: s.resourceGroup,
  managedInstanceName: s.managedInstanceName,
  databaseName: s.databaseName,
});

/**
 * Salted fingerprint over one or more write-only secrets (e.g. a storage
 * key and a SAS token), so a change to any of them can be detected
 * without persisting the secrets.
 */
export const secretsFingerprint = (
  salt: string,
  secrets: ReadonlyArray<Redacted.Redacted<string> | undefined>,
) =>
  secrets.every((secret) => secret === undefined)
    ? Effect.succeed(undefined)
    : Effect.sync(() =>
        Redacted.make(
          secrets
            .map((secret) =>
              secret === undefined ? "" : Redacted.value(secret),
            )
            .join("\u0000"),
        ),
      ).pipe(Effect.flatMap((combined) => secretFingerprint(salt, combined)));

/** `https://<vault>.vault.azure.net/keys/<key>/<version>` → `<vault>_<key>_<version>`. */
export const serverKeyNameOf = (uri: string) => {
  const match = /^https:\/\/([^.]+)\.[^/]+\/keys\/([^/]+)\/([^/?]+)/i.exec(uri);
  return match === null ? uri : `${match[1]}_${match[2]}_${match[3]}`;
};

/** Location of an elastic job agent child. */
export interface JobAgentScope extends ServerScope {
  jobAgentName: string;
}

/** Location of an elastic job child (a step). */
export interface JobScope extends JobAgentScope {
  jobName: string;
}

export const jobAgentPath = (subscriptionId: string, s: JobAgentScope) => ({
  subscriptionId,
  resourceGroupName: s.resourceGroup,
  serverName: s.serverName,
  jobAgentName: s.jobAgentName,
});

export const jobPath = (subscriptionId: string, s: JobScope) => ({
  ...jobAgentPath(subscriptionId, s),
  jobName: s.jobName,
});

/**
 * Retry a write while the elastic job agent processes another request
 * (`ElasticJobAgentIsBusy`).
 */
export const retryWhileAgentBusy = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
) =>
  self.pipe(
    Effect.retry({
      while: (e) => e._tag === "ElasticJobAgentIsBusy",
      schedule: Schedule.spaced("15 seconds"),
      times: 40,
    }),
  );

/** Location of a workload classifier. */
export interface WorkloadGroupScope extends DatabaseScope {
  workloadGroupName: string;
}

export const workloadGroupPath = (
  subscriptionId: string,
  s: WorkloadGroupScope,
) => ({
  ...databasePath(subscriptionId, s),
  workloadGroupName: s.workloadGroupName,
});
