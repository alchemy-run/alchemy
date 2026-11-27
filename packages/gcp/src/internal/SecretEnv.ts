/**
 * The secret environment of a Cloud Run host (`GCP.Run.Service`,
 * `GCP.Run.WorkerPool`, `GCP.Run.Job`, and the `GCP.Run.Container`s they
 * run as sidecars).
 *
 * A revision's plain `env` values are returned by `run.services.get` (and
 * the worker pool and job equivalents), so anyone who can view the host can
 * read them. Every `Redacted` env value (the user's `env`, a binding's, or a
 * value the runtime context bound, such as a Rivet token) is therefore kept
 * out of the revision: it goes into a Secret Manager secret of the host's
 * own, one per container and key, and the container reads it through
 * `valueSource.secretKeyRef`, pinned to the version that holds it. A new
 * value is a new version, so it rolls out as a new revision; once the
 * rollout is done, versions no serving revision reads are destroyed.
 *
 * `GCP.CloudFunctions.Function` keeps its secret env the same way, as one
 * unnamed container whose references become `secretEnvironmentVariables`.
 *
 * @internal
 */
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import { envString } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { fnv1a64, type GcpIamGrant } from "../Host.ts";
import { createInternalLabels } from "../Labels.ts";
import { revealOptional } from "./SdkSecret.ts";

/** The role that lets a host's service account read its secrets. */
export const SECRET_ACCESSOR = "roles/secretmanager.secretAccessor";

/** Label naming the host a secret env secret belongs to. */
const HOST_LABEL = "alchemy-secret-env";

/** The host whose secret environment is synced. */
export interface SecretEnvHost {
  project: string;
  /** Host resource type, e.g. `GCP.Run.Service`. */
  hostType: string;
  /** Full resource name of the host. */
  resourceName: string;
}

/** An env entry of a container in a revision template. */
export type SecretEnvVar = {
  name?: string;
  value?: string | Redacted.Redacted<string>;
  valueSource?: { secretKeyRef?: { secret?: string; version?: string } };
};

type ContainerLike = { name?: string; env?: SecretEnvVar[] };

/** A container whose env holds no `Redacted` value any more. */
type Sealed<C extends ContainerLike> = Omit<C, "env"> & {
  env?: Array<Omit<SecretEnvVar, "value"> & { value?: string }>;
};

/** The hash every secret of one host carries in its id and label. */
const hostHash = (host: SecretEnvHost) =>
  fnv1a64(`${host.hostType}:${host.resourceName}`).slice(0, 12);

/** The container's segment of a secret id: its name, or `main` for an unnamed one. */
const containerSegment = (container: ContainerLike, index: number) =>
  container.name !== undefined && container.name.length > 0
    ? container.name
    : index === 0
      ? "main"
      : `c${index}`;

/**
 * The id of the secret holding one env value of one container of a host.
 * Container names are DNS labels and keys keep only `[A-Za-z0-9_]`, so no
 * two (container, key) pairs share an id.
 */
export const secretEnvId = (host: SecretEnvHost, container: string, key: string) => {
  const clean = key.replace(/[^A-Za-z0-9_]/g, "_");
  const suffix = clean === key ? clean : `${clean}_${fnv1a64(key).slice(0, 8)}`;
  return `alch-${hostHash(host)}-${container}-${suffix}`.slice(0, 255);
};

const secretName = (project: string, secretId: string) => `projects/${project}/secrets/${secretId}`;

/** Every secret env secret of a host, by id. */
const listHostSecrets = (host: SecretEnvHost) =>
  secretmanager.listProjectsSecrets
    .pages({
      parent: `projects/${host.project}`,
      pageSize: 1000,
      filter: `labels.${HOST_LABEL}=${hostHash(host)}`,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.secrets ?? [])),
      Stream.map((secret) => (secret.name ?? "").split("/").pop() ?? ""),
      Stream.filter((id) => id.length > 0),
      Stream.runCollect,
      Effect.map((ids) => new Set(ids)),
    );

/** Create the secret if it is missing; a concurrent create is a race, not a failure. */
const ensureSecret = Effect.fn(function* (
  host: SecretEnvHost,
  secretId: string,
  labels: Record<string, string>,
) {
  const name = secretName(host.project, secretId);
  const existing = yield* secretmanager
    .getProjectsSecrets({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
  if (existing !== undefined) return;
  yield* secretmanager
    .createProjectsSecrets({
      parent: `projects/${host.project}`,
      secretId,
      replication: { automatic: {} },
      labels,
    })
    .pipe(
      // A just-deleted secret keeps its id reserved for a few seconds.
      Effect.retry({
        while: (error) => error._tag === "Conflict",
        schedule: Schedule.spaced("1 second"),
        times: 10,
      }),
      Effect.catchTag("Conflict", () => Effect.void),
    );
});

/**
 * Make the secret's latest version hold `value`: add a version only when it
 * holds something else, so an unchanged deploy keeps the revision as it is.
 * Returns the version number.
 */
const syncSecretValue = Effect.fn(function* (name: string, value: string) {
  const latest = yield* secretmanager
    .accessProjectsSecretsVersions({ name: `${name}/versions/latest` })
    .pipe(Effect.catchTag(["NotFound", "SecretVersionNotEnabled"], () => Effect.undefined));
  const data = revealOptional(latest?.payload?.data);
  const observed = data === undefined ? undefined : Buffer.from(data, "base64").toString("utf8");
  if (latest?.name !== undefined && observed === value) {
    return versionOf(latest.name);
  }
  const added = yield* secretmanager.addVersionProjectsSecrets({
    parent: name,
    payload: { data: Buffer.from(value, "utf8").toString("base64") },
  });
  return versionOf(added.name ?? "");
});

const versionOf = (versionName: string) => versionName.split("/").pop() ?? "";

/**
 * Move every `Redacted` env value of `containers` into the host's
 * Secret Manager secrets and reference it with a version-pinned
 * `secretKeyRef`. Plain values stay plain. Returns the sealed containers,
 * the ids of the secrets they read, and the grants that let the host's
 * service account read every secret of the host (those of the revisions
 * still serving included), to sync before the revision rolls out.
 *
 * A host that has no secret, and recorded none, never calls Secret Manager,
 * so its API need not be enabled.
 */
export const sealSecretEnv = Effect.fn(function* <C extends ContainerLike>(options: {
  host: SecretEnvHost;
  /** Logical id of the host, whose ownership labels the secrets carry. */
  id: string;
  containers: readonly C[];
  /** Secret ids the host recorded on its last deploy. */
  previous: readonly string[] | undefined;
}) {
  const { host } = options;
  const labels = { ...(yield* createInternalLabels(options.id)), [HOST_LABEL]: hostHash(host) };
  const desired = new Set<string>();
  const containers: Sealed<C>[] = [];
  for (const [index, container] of options.containers.entries()) {
    const segment = containerSegment(container, index);
    const env: NonNullable<Sealed<C>["env"]> = [];
    for (const entry of container.env ?? []) {
      if (!Redacted.isRedacted(entry.value)) {
        env.push(entry as Omit<SecretEnvVar, "value"> & { value?: string });
        continue;
      }
      const secretId = secretEnvId(host, segment, entry.name ?? "");
      yield* ensureSecret(host, secretId, labels);
      const version = yield* syncSecretValue(
        secretName(host.project, secretId),
        envString(entry.value) ?? "",
      );
      desired.add(secretId);
      env.push({ name: entry.name, valueSource: { secretKeyRef: { secret: secretId, version } } });
    }
    containers.push({
      ...container,
      ...(container.env === undefined ? {} : { env }),
    } as Sealed<C>);
  }
  // Secrets of keys that went away stay readable until the revisions
  // reading them stop serving; `pruneSecretEnv` deletes them after.
  const owned = hasSecretEnv(desired, options.previous)
    ? yield* listHostSecrets(host)
    : new Set<string>();
  const readable = new Set([...desired, ...owned]);
  const grants: GcpIamGrant[] = [...readable].sort().map((secretId) => ({
    role: SECRET_ACCESSOR,
    resource: { kind: "secretmanager.secret", name: secretName(host.project, secretId) },
  }));
  return { containers, secrets: desired, grants };
});

/** True when a host has, or recorded, a secret env secret. */
export const hasSecretEnv = (
  secrets: ReadonlySet<string>,
  previous: readonly string[] | undefined,
) => secrets.size > 0 || (previous?.length ?? 0) > 0;

/** The secret env references (`secretId` → versions) of revision containers. */
export const secretRefsOf = (
  containers: ReadonlyArray<{ env?: ReadonlyArray<cloudrun.GoogleCloudRunV2EnvVar> }>,
) => {
  const refs = new Map<string, Set<string>>();
  for (const container of containers) {
    for (const entry of container.env ?? []) {
      const ref = entry.valueSource?.secretKeyRef;
      if (ref?.secret === undefined || ref.version === undefined) continue;
      const secretId = ref.secret.split("/").pop() ?? ref.secret;
      const versions = refs.get(secretId) ?? new Set<string>();
      versions.add(ref.version);
      refs.set(secretId, versions);
    }
  }
  return refs;
};

/** Union of secret env references. */
export const mergeSecretRefs = (
  ...all: ReadonlyArray<ReadonlyMap<string, ReadonlySet<string>>>
) => {
  const merged = new Map<string, Set<string>>();
  for (const refs of all) {
    for (const [secretId, versions] of refs) {
      merged.set(secretId, new Set([...(merged.get(secretId) ?? []), ...versions]));
    }
  }
  return merged;
};

/**
 * Undo the secrets a failed first deploy made: the engine records no
 * output for it, so it never deletes them.
 */
export const discardSecretEnv = (host: SecretEnvHost, secrets: ReadonlySet<string>) =>
  Effect.forEach(
    secrets,
    (secretId) =>
      secretmanager
        .deleteProjectsSecrets({ name: secretName(host.project, secretId) })
        .pipe(Effect.ignore),
    { discard: true },
  );

/**
 * The secret env references of the revisions that serve traffic (a Service)
 * or instances (a WorkerPool) once a rollout is done.
 */
export const servingRevisionRefs = Effect.fn(function* <E extends { _tag: string }, R>(options: {
  /** Full resource name of the Service or WorkerPool. */
  parent: string;
  latestReadyRevision: string | undefined;
  /** Revisions named by `trafficStatuses` / `instanceSplitStatuses`. */
  revisions: ReadonlyArray<string | undefined>;
  get: (name: string) => Effect.Effect<cloudrun.GoogleCloudRunV2Revision, E, R>;
}) {
  const names = new Set<string>();
  for (const revision of [options.latestReadyRevision, ...options.revisions]) {
    if (revision === undefined || revision.length === 0) continue;
    names.add(revision.includes("/") ? revision : `${options.parent}/revisions/${revision}`);
  }
  const containers: cloudrun.GoogleCloudRunV2Container[] = [];
  for (const name of names) {
    // A revision deleted meanwhile reads nothing.
    const revision = yield* options.get(name).pipe(
      Effect.catchIf(
        (error) => error._tag === "NotFound",
        () => Effect.undefined,
      ),
    );
    containers.push(...(revision?.containers ?? []));
  }
  return secretRefsOf(containers);
});

/** The secret env references of a Job's executions that are still running. */
export const runningExecutionRefs = Effect.fn(function* (jobName: string) {
  const executions = yield* cloudrun.listProjectsLocationsJobsExecutions
    .pages({ parent: jobName, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.executions ?? [])),
      Stream.filter((execution) => execution.completionTime === undefined),
      Stream.runCollect,
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );
  return secretRefsOf([...executions].flatMap((execution) => execution.template?.containers ?? []));
});

/**
 * After a rollout: delete the host's secrets nothing reads any more, and
 * destroy the versions of the others that neither the new revision nor a
 * revision (or execution) still in use reads.
 */
export const pruneSecretEnv = Effect.fn(function* (options: {
  host: SecretEnvHost;
  /** Secrets the new revision reads. */
  secrets: ReadonlySet<string>;
  /** Secret ids the host recorded on its last deploy. */
  previous: readonly string[] | undefined;
  /** `secretId` → versions in use, the new revision's included. */
  inUse: ReadonlyMap<string, ReadonlySet<string>>;
}) {
  const { host } = options;
  if (!hasSecretEnv(options.secrets, options.previous)) return;
  for (const secretId of yield* listHostSecrets(host)) {
    const name = secretName(host.project, secretId);
    const versions = options.inUse.get(secretId);
    if (!options.secrets.has(secretId) && (versions === undefined || versions.size === 0)) {
      yield* secretmanager
        .deleteProjectsSecrets({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      continue;
    }
    const stale = yield* secretmanager.listProjectsSecretsVersions
      .pages({ parent: name, pageSize: 100 })
      .pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.versions ?? [])),
        Stream.filter(
          (version) =>
            version.name !== undefined &&
            version.state !== "DESTROYED" &&
            !(versions?.has(versionOf(version.name)) ?? false),
        ),
        Stream.runCollect,
        Effect.catchTag("NotFound", () => Effect.succeed([])),
      );
    for (const version of stale) {
      yield* secretmanager
        .destroyProjectsSecretsVersions({ name: version.name! })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
  }
});

/**
 * Delete every secret env secret of a host; absent is fine. A host that
 * recorded none has none to delete.
 */
export const deleteSecretEnv = Effect.fn(function* (
  host: SecretEnvHost,
  previous: readonly string[] | undefined,
) {
  if ((previous?.length ?? 0) === 0) return;
  for (const secretId of new Set([...previous!, ...(yield* listHostSecrets(host))])) {
    yield* secretmanager
      .deleteProjectsSecrets({ name: secretName(host.project, secretId) })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
  }
});
