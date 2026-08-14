/**
 * The Vercel deploy engine (DESIGN §6) — a library, not a service.
 *
 * Plain Effect functions shared by the `Project` and `Function` providers:
 * observe/ensure the project, sync settings and env by observed-vs-desired
 * delta, and drive `DeploymentArtifact → upload → createDeployment → READY`.
 *
 * NOT exported from `Vercel/index.ts`.
 */
import * as deployments from "@distilled.cloud/vercel/deployments";
import * as projects from "@distilled.cloud/vercel/projects";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import { sha256, sha256Object } from "../../Util/sha256.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";
import { readArtifactFile, type DeploymentArtifact } from "./Artifact.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Ownership (DESIGN §5.4) — Vercel has no tags; ownership is an env-var stamp
// on the project plus `meta.alchemy*` stamps on every deployment.
// ─────────────────────────────────────────────────────────────────────────────

export const ALCHEMY_META_KEY = "ALCHEMY_META";

export interface OwnershipStamp {
  readonly stack: string;
  readonly stage: string;
  readonly logicalId: string;
}

export const makeOwnershipStamp = (
  logicalId: string,
): Effect.Effect<OwnershipStamp, never, Stack | Stage> =>
  Effect.gen(function* () {
    const stack = yield* Stack;
    const stage = yield* Stage;
    return { stack: stack.name, stage, logicalId };
  });

/** Deployment `meta` stamps (DESIGN §5.4 / §6.6). */
export const makeDeploymentMeta = (
  stamp: OwnershipStamp,
  contentHash: string,
): Record<string, string> => ({
  alchemyContentHash: contentHash,
  alchemyStack: stamp.stack,
  alchemyStage: stamp.stage,
  alchemyLogicalId: stamp.logicalId,
});

// ─────────────────────────────────────────────────────────────────────────────
// Typed engine errors
// ─────────────────────────────────────────────────────────────────────────────

export class DeploymentFailed extends Data.TaggedError(
  "Vercel.DeploymentFailed",
)<{
  readonly message: string;
  readonly deploymentId: string;
  readonly readyState: string;
  readonly errorCode?: string;
  /** Tail of the build log events. */
  readonly logs: ReadonlyArray<string>;
}> {}

export class DeploymentTimeout extends Data.TaggedError(
  "Vercel.DeploymentTimeout",
)<{
  readonly message: string;
  readonly deploymentId: string;
  readonly readyState: string;
}> {}

export class AliasAssignmentFailed extends Data.TaggedError(
  "Vercel.AliasAssignmentFailed",
)<{
  readonly message: string;
  readonly deploymentId: string;
  readonly code?: string;
}> {}

// ─────────────────────────────────────────────────────────────────────────────
// Project observe / ensure / settings sync
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Observe a project by id or name. A missing project resolves `undefined`
 * (typed `NotFound`, distilled patch 004).
 */
export const observeProject = (idOrName: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    return yield* projects
      .getProject({ idOrName, teamId })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
  });

/**
 * Desired project settings — the mutable scalar surface v1 manages.
 */
export interface ProjectSettingsDesired {
  readonly nodeVersion?: string;
  readonly resourceConfig?: {
    readonly fluid?: boolean;
    readonly functionDefaultMemoryType?: string;
    readonly functionDefaultTimeout?: number;
    readonly functionDefaultRegions?: ReadonlyArray<string>;
  };
}

/**
 * Ensure the project exists (observe → create on missing, catching the
 * typed `Conflict` race → re-get) and return the observed project body.
 */
export const ensureProject = (input: {
  readonly name: string;
  readonly desired?: ProjectSettingsDesired;
}) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    const observed = yield* observeProject(input.name);
    if (observed !== undefined) {
      return observed;
    }
    yield* projects
      .createProject({
        teamId,
        name: input.name,
        ...(input.desired?.resourceConfig !== undefined
          ? {
              resourceConfig: {
                fluid: input.desired.resourceConfig.fluid,
                functionDefaultMemoryType:
                  input.desired.resourceConfig.functionDefaultMemoryType,
                functionDefaultTimeout:
                  input.desired.resourceConfig.functionDefaultTimeout,
                functionDefaultRegions:
                  input.desired.resourceConfig.functionDefaultRegions !==
                  undefined
                    ? [...input.desired.resourceConfig.functionDefaultRegions]
                    : undefined,
              },
            }
          : {}),
      })
      // Two reconcilers racing on the same deterministic name: the loser's
      // Conflict is a success signal — the project exists.
      .pipe(
        Effect.catchTag("Conflict", () => Effect.void),
        Effect.asVoid,
      );
    const project = yield* observeProject(input.name);
    if (project === undefined) {
      // Created (or conflicted with an existing create) but not yet
      // observable — treat as an engine defect rather than inventing state.
      return yield* Effect.die(
        `Vercel project '${input.name}' not observable immediately after create`,
      );
    }
    return project;
  });

/**
 * Sync mutable project settings by observed-vs-desired delta — PATCH only
 * when something actually differs.
 */
export const syncProjectSettings = (input: {
  readonly project: projects.GetProjectResponse;
  readonly desired: ProjectSettingsDesired;
}) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    const { project, desired } = input;

    interface ResourceConfigPatch {
      fluid?: boolean;
      functionDefaultMemoryType?: string;
      functionDefaultTimeout?: number;
      functionDefaultRegions?: string[];
    }
    const patch: {
      nodeVersion?: string;
      resourceConfig?: ResourceConfigPatch;
    } = {};

    if (
      desired.nodeVersion !== undefined &&
      desired.nodeVersion !== project.nodeVersion
    ) {
      patch.nodeVersion = desired.nodeVersion;
    }

    if (desired.resourceConfig !== undefined) {
      const observed = project.resourceConfig as {
        fluid?: boolean;
        functionDefaultMemoryType?: string;
        functionDefaultTimeout?: number;
        functionDefaultRegions?: ReadonlyArray<string>;
      };
      const rc: ResourceConfigPatch = {};
      if (
        desired.resourceConfig.fluid !== undefined &&
        desired.resourceConfig.fluid !== observed?.fluid
      ) {
        rc.fluid = desired.resourceConfig.fluid;
      }
      if (
        desired.resourceConfig.functionDefaultMemoryType !== undefined &&
        desired.resourceConfig.functionDefaultMemoryType !==
          observed?.functionDefaultMemoryType
      ) {
        rc.functionDefaultMemoryType =
          desired.resourceConfig.functionDefaultMemoryType;
      }
      if (
        desired.resourceConfig.functionDefaultTimeout !== undefined &&
        desired.resourceConfig.functionDefaultTimeout !==
          observed?.functionDefaultTimeout
      ) {
        rc.functionDefaultTimeout =
          desired.resourceConfig.functionDefaultTimeout;
      }
      if (
        desired.resourceConfig.functionDefaultRegions !== undefined &&
        JSON.stringify(desired.resourceConfig.functionDefaultRegions) !==
          JSON.stringify(observed?.functionDefaultRegions)
      ) {
        rc.functionDefaultRegions = [
          ...desired.resourceConfig.functionDefaultRegions,
        ];
      }
      if (Object.keys(rc).length > 0) {
        patch.resourceConfig = rc;
      }
    }

    if (Object.keys(patch).length === 0) {
      return { changed: false as const };
    }
    yield* projects.updateProject({
      idOrName: project.id,
      teamId,
      ...(patch.nodeVersion !== undefined
        ? { nodeVersion: patch.nodeVersion }
        : {}),
      ...(patch.resourceConfig !== undefined
        ? { resourceConfig: patch.resourceConfig }
        : {}),
    });
    return { changed: true as const };
  });

// ─────────────────────────────────────────────────────────────────────────────
// Env sync
// ─────────────────────────────────────────────────────────────────────────────

export type EnvTarget = "production" | "preview" | "development";

export const ALL_ENV_TARGETS: ReadonlyArray<EnvTarget> = [
  "production",
  "preview",
  "development",
];

/**
 * Sensitive env vars cannot target `development` — Vercel rejects the row
 * with `BAD_REQUEST "You cannot set a Sensitive Environment Variable's
 * target to development"` (live-verified) — so their default excludes it.
 */
export const SENSITIVE_ENV_TARGETS: ReadonlyArray<EnvTarget> = [
  "production",
  "preview",
];

export interface DesiredEnv {
  readonly key: string;
  /** Raw value — `Redacted` values become `sensitive` project env vars. */
  readonly value: string | Redacted.Redacted<string>;
  readonly type?: "plain" | "encrypted" | "sensitive";
  readonly target?: ReadonlyArray<EnvTarget>;
}

/** Observed env row (normalized across the response union's cases). */
interface EnvRow {
  readonly id?: string;
  readonly key: string;
  readonly value?: string;
  readonly type: string;
  readonly comment?: string;
  readonly target?: unknown;
  /**
   * `false` when `value` is an opaque ciphertext envelope even with
   * decrypt=true (live-verified: teams on v2 env encryption never return
   * plaintext for `encrypted` rows) — the value is unobservable then.
   */
  readonly decrypted?: boolean;
}

const targetsOf = (t: unknown): string[] =>
  Array.isArray(t)
    ? [...t].map(String).sort()
    : typeof t === "string"
      ? [t]
      : [];

const toEnvRows = (body: projects.FilterProjectEnvsResponse): EnvRow[] =>
  typeof body === "object" && body !== null && "envs" in body
    ? ([...body.envs] as EnvRow[])
    : typeof body === "object" && body !== null && "key" in body
      ? [body as EnvRow]
      : [];

/** List a project's env vars, decrypting readable values for diffing. */
export const listProjectEnvs = (idOrName: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    const body = yield* projects.filterProjectEnvs({
      idOrName,
      teamId,
      decrypt: "true",
    });
    return toEnvRows(body);
  });

/** `alchemy:sha256:<hash>` fingerprint comment for sensitive env values. */
export const sensitiveFingerprint = (value: string) =>
  Effect.map(sha256(value), (hash) => `alchemy:sha256:${hash}`);

/**
 * Persisted baseline row for an alchemy-managed project env var.
 *
 * The baseline is the removal gate for every managed key, and the drift
 * baseline whenever the cloud value is unobservable (live-verified):
 * sensitive rows list with an EMPTY `value`, and on teams with v2 env
 * encryption even `encrypted` rows come back as ciphertext with
 * `decrypted: false` despite decrypt=true.
 */
export interface ManagedEnvEntry {
  readonly key: string;
  readonly type: string;
  /**
   * `alchemy:sha256:<hash>` of the resolved value at the last successful
   * write. Absent after a failed write so the next reconcile retries.
   */
  readonly fingerprint?: string;
  /**
   * Sensitive rows only: env row id captured from the `createProjectEnv`
   * response — a removal fallback if the row ever drops out of the listing.
   */
  readonly id?: string;
  /** Sensitive rows only: sorted targets at the last write. */
  readonly target?: ReadonlyArray<string>;
}

const desiredRow = (env: DesiredEnv) =>
  Effect.gen(function* () {
    const isSensitive =
      env.type === "sensitive" || Redacted.isRedacted(env.value);
    const raw = Redacted.isRedacted(env.value)
      ? Redacted.value(env.value)
      : env.value;
    // Every row gets a value fingerprint — the drift baseline whenever the
    // cloud value is unobservable (sensitive rows always; encrypted rows on
    // teams whose listing returns `decrypted: false` ciphertext).
    const fingerprint = yield* sensitiveFingerprint(raw);
    const defaultTargets = isSensitive
      ? SENSITIVE_ENV_TARGETS
      : ALL_ENV_TARGETS;
    // Sensitive rows may never target development, even when asked to.
    const targets = (env.target ?? defaultTargets).filter(
      (t) => !isSensitive || t !== "development",
    );
    return {
      key: env.key,
      value: raw,
      type: isSensitive ? ("sensitive" as const) : (env.type ?? "encrypted"),
      target: [...targets],
      fingerprint,
      // The fingerprint ships as the row's comment for humans in the
      // dashboard (sensitive rows only) — nothing depends on reading it back.
      ...(isSensitive ? { comment: fingerprint } : {}),
    };
  });

/**
 * Converge project env vars on the desired set (DESIGN §6.3 step 4).
 *
 * - Plain/encrypted rows diff against the OBSERVED cloud rows from
 *   `filterProjectEnvs` (adoption-safe) when the value is readable.
 * - Unobservable values diff the desired `alchemy:sha256:<hash>`
 *   fingerprint against the PERSISTED baseline and are upserted only on
 *   mismatch/absence. This covers sensitive rows (always write-only — the
 *   listing returns them with an EMPTY `value`, live-verified) and
 *   encrypted rows whose observed row has `decrypted: false` (v2 env
 *   encryption ciphertext). The fingerprint also ships as a sensitive
 *   row's `comment` for humans in the dashboard, but nothing DEPENDS on
 *   reading it back.
 * - `managedEnv` is the removal baseline: only keys alchemy previously
 *   managed are ever removed, so foreign env vars survive adoption.
 *   A sensitive row that drops out of the listing is removed via the
 *   persisted row id (captured from the `createProjectEnv` response).
 *
 * Returns whether anything changed (env changes force a redeploy) and the
 * new managed-env baseline for the caller to persist.
 */
export const syncProjectEnv = (input: {
  readonly idOrName: string;
  readonly desired: ReadonlyArray<DesiredEnv>;
  readonly managedEnv: ReadonlyArray<ManagedEnvEntry>;
}) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    const observed = yield* listProjectEnvs(input.idOrName);
    const observedByKey = new Map(observed.map((row) => [row.key, row]));
    const baselineByKey = new Map(input.managedEnv.map((e) => [e.key, e]));

    const rows = yield* Effect.forEach(input.desired, desiredRow);

    const upserts = rows.filter((row) => {
      if (row.type === "sensitive") {
        // Value unobservable (listed empty) — diff the persisted baseline.
        const baseline = baselineByKey.get(row.key);
        if (baseline === undefined) return true;
        if (baseline.type !== "sensitive") return true;
        if (baseline.fingerprint !== row.fingerprint) return true;
        const baselineTargets = [...(baseline.target ?? [])].sort();
        return baselineTargets.join(",") !== [...row.target].sort().join(",");
      }
      const current = observedByKey.get(row.key);
      if (current === undefined) return true;
      if (current.type !== row.type) return true;
      const observedTargets = targetsOf(current.target);
      const desiredTargets = [...row.target].sort();
      if (observedTargets.join(",") !== desiredTargets.join(",")) return true;
      if (current.decrypted === false) {
        // Undecryptable ciphertext (v2 env encryption) — the observed value
        // can't be compared; diff the persisted fingerprint instead.
        return baselineByKey.get(row.key)?.fingerprint !== row.fingerprint;
      }
      return current.value !== row.value;
    });

    // Capture created row ids (sensitive rows persist theirs as the future
    // removal handle) and per-key failures (a failed sensitive write must
    // not bank its fingerprint).
    const createdIdByKey = new Map<string, string>();
    const failedKeys = new Set<string>();
    if (upserts.length > 0) {
      const response = yield* projects.createProjectEnv({
        idOrName: input.idOrName,
        teamId,
        upsert: "true",
        // `fingerprint` is engine metadata, not part of the wire row.
        body: upserts.map(({ fingerprint: _fingerprint, ...wire }) => wire),
      });
      const createdRows = Array.isArray(response.created)
        ? response.created
        : [response.created];
      for (const created of createdRows) {
        if (created.id !== undefined) {
          createdIdByKey.set(created.key, created.id);
        }
      }
      for (const failure of response.failed) {
        const key = failure.error.envVarKey ?? failure.error.key;
        if (key !== undefined) failedKeys.add(key);
        yield* Effect.logWarning(
          `Vercel env upsert failed for '${key ?? "<unknown>"}' on ${input.idOrName}: ${failure.error.code} ${failure.error.message}`,
        );
      }
    }

    const desiredKeys = new Set(rows.map((row) => row.key));
    const managedKeys = new Set(input.managedEnv.map((e) => e.key));
    // Plain/encrypted removals: resolve the row id from the listing.
    const observedRemovals = observed.filter(
      (row) =>
        row.id !== undefined &&
        managedKeys.has(row.key) &&
        !desiredKeys.has(row.key),
    );
    let removed = 0;
    for (const row of observedRemovals) {
      yield* projects
        .removeProjectEnv({
          idOrName: input.idOrName,
          id: row.id!,
          teamId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      removed++;
    }
    // Sensitive removals whose row dropped out of the listing: fall back
    // to the persisted id; skip with a note when none was captured.
    const sensitiveRemovals = input.managedEnv.filter(
      (entry) =>
        entry.type === "sensitive" &&
        !desiredKeys.has(entry.key) &&
        !observedByKey.has(entry.key),
    );
    for (const entry of sensitiveRemovals) {
      if (entry.id === undefined) {
        yield* Effect.logWarning(
          `Vercel sensitive env '${entry.key}' on ${input.idOrName} has no persisted row id — skipping removal (delete it in the dashboard if it still exists)`,
        );
        continue;
      }
      yield* projects
        .removeProjectEnv({
          idOrName: input.idOrName,
          id: entry.id,
          teamId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      removed++;
    }

    const managedEnv = rows.map((row): ManagedEnvEntry => {
      const previous = baselineByKey.get(row.key);
      // A failed write keeps the previous fingerprint (last successful
      // write) so the next reconcile retries the upsert.
      const fingerprint = failedKeys.has(row.key)
        ? previous?.fingerprint
        : row.fingerprint;
      if (row.type !== "sensitive") {
        return {
          key: row.key,
          type: row.type,
          ...(fingerprint !== undefined ? { fingerprint } : {}),
        };
      }
      const id =
        createdIdByKey.get(row.key) ??
        (previous?.type === "sensitive" ? previous.id : undefined);
      return {
        key: row.key,
        type: "sensitive",
        ...(fingerprint !== undefined ? { fingerprint } : {}),
        ...(id !== undefined ? { id } : {}),
        target: [...row.target].sort(),
      };
    });

    return {
      changed: upserts.length > 0 || removed > 0,
      managedEnv,
    };
  });

/** Stable hash over the fully-resolved desired env rows. */
export const hashDesiredEnv = (desired: ReadonlyArray<DesiredEnv>) =>
  Effect.flatMap(Effect.forEach(desired, desiredRow), (rows) =>
    sha256Object(
      [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    ),
  );

// ─────────────────────────────────────────────────────────────────────────────
// Protection bypass (DESIGN §6.7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find an existing automation-bypass secret on an observed project body.
 * The secret IS the key of the `protectionBypass` map (live-verified);
 * entries with other scopes (integration bypasses) are ignored.
 */
export const findAutomationBypassSecret = (
  project: projects.GetProjectResponse,
): string | undefined => {
  const map = project.protectionBypass as
    | Record<string, { scope?: string } | undefined>
    | undefined;
  if (map === undefined) return undefined;
  for (const [secret, entry] of Object.entries(map)) {
    if (entry?.scope === "automation-bypass") {
      return secret;
    }
  }
  return undefined;
};

/**
 * Ensure the project carries an automation bypass secret, minting one via
 * `PATCH /v1/projects/{id}/protection-bypass {generate:{note}}` when absent.
 *
 * **Observe-and-keep**: an existing secret is NEVER regenerated — bypass
 * secrets only open deployments created AFTER they were minted
 * (live-verified), so regenerating would orphan every older deployment.
 * For the same reason callers mint BEFORE the first deploy, never lazily.
 */
export const ensureProtectionBypass = (project: projects.GetProjectResponse) =>
  Effect.gen(function* () {
    const existing = findAutomationBypassSecret(project);
    if (existing !== undefined) {
      return Redacted.make(existing);
    }
    const { teamId } = yield* VercelEnvironment.current;
    const response = yield* projects.updateProjectProtectionBypass({
      idOrName: project.id,
      teamId,
      generate: { note: "alchemy automation bypass" },
    });
    const minted = Object.entries(response.protectionBypass ?? {}).find(
      ([, entry]) =>
        (entry as { scope?: string } | undefined)?.scope ===
        "automation-bypass",
    )?.[0];
    if (minted === undefined) {
      return yield* Effect.die(
        `Vercel project ${project.id}: protection-bypass generate returned no automation-bypass secret`,
      );
    }
    return Redacted.make(minted);
  });

/**
 * Read the project's ownership stamp from its env vars. `undefined` when no
 * stamp is present (foreign project → `Unowned` gating in `read`).
 */
export const readOwnershipStamp = (idOrName: string) =>
  Effect.gen(function* () {
    const rows = yield* listProjectEnvs(idOrName);
    const stamp = rows.find((row) => row.key === ALCHEMY_META_KEY);
    if (stamp?.value === undefined) return undefined;
    try {
      return JSON.parse(stamp.value) as OwnershipStamp;
    } catch {
      return undefined;
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// Deployments
// ─────────────────────────────────────────────────────────────────────────────

type DeploymentSnapshot =
  | deployments.CreateDeploymentResponse
  | deployments.GetDeploymentResponse;

const readyStateOf = (d: DeploymentSnapshot): string => d.readyState;

const idOf = (d: DeploymentSnapshot): string => d.id;

const urlOf = (d: DeploymentSnapshot): string | undefined =>
  "url" in d ? d.url : undefined;

const aliasesOf = (d: DeploymentSnapshot): ReadonlyArray<string> =>
  "alias" in d && Array.isArray(d.alias) ? d.alias : [];

const aliasErrorOf = (
  d: DeploymentSnapshot,
): { code?: string; message?: string } | undefined =>
  "aliasError" in d && d.aliasError !== null && d.aliasError !== undefined
    ? (d.aliasError as { code?: string; message?: string })
    : undefined;

const isTerminal = (readyState: string): boolean =>
  readyState === "READY" || readyState === "ERROR" || readyState === "CANCELED";

/** Fetch the tail of a deployment's build log as plain text lines. */
const buildLogTail = (deploymentId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    const events = yield* deployments.getDeploymentEvents({
      idOrUrl: deploymentId,
      teamId,
      builds: 1,
      limit: 100,
    });
    return events.flatMap((event) => {
      if (typeof event !== "object" || event === null) return [];
      if ("payload" in event) {
        const text = (event.payload as { text?: string }).text;
        return typeof text === "string" && text.length > 0 ? [text] : [];
      }
      if ("text" in event && typeof event.text === "string") {
        return [event.text];
      }
      return [];
    });
  }).pipe(
    // Best-effort: a failed log fetch must not mask the DeploymentFailed.
    Effect.orElseSucceed(() => [] as string[]),
  );

export interface DeployResult {
  readonly deploymentId: string;
  /** Deployment-specific hostname (e.g. `proj-abc123.vercel.app`). */
  readonly deploymentUrl: string | undefined;
  /** Aliases assigned at creation (production domain first when present). */
  readonly aliases: ReadonlyArray<string>;
  readonly aliasAssigned: boolean;
}

/**
 * Upload-all-first + `POST /v13/deployments` + poll-to-READY
 * (DESIGN §6.2, upload facts per PROBES.md).
 */
export const deployArtifact = (input: {
  readonly projectName: string;
  readonly artifact: DeploymentArtifact;
  readonly target: "production" | "preview";
  readonly meta: Record<string, string>;
  readonly session?: { note: (note: string) => Effect.Effect<void> };
}) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;

    // 1. Upload every file (SHA-dedup server-side makes re-sends near-free;
    //    response is `{urls:[...]}` — never asserted empty). Bounded retry
    //    on transport blips only; API-level retry is distilled's policy.
    yield* Effect.forEach(
      input.artifact.files,
      (file) =>
        Effect.gen(function* () {
          const bytes = yield* readArtifactFile(file);
          yield* deployments
            .uploadFile({
              teamId,
              xVercelDigest: file.sha1,
              contentLength: file.size,
              body: bytes,
            })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "HttpClientError",
                schedule: Schedule.exponential("250 millis"),
                times: 4,
              }),
            );
        }),
      { concurrency: 8 },
    );

    // 2. Create the deployment referencing the uploaded blobs.
    const created = yield* deployments.createDeployment({
      teamId,
      forceNew: "1",
      skipAutoDetectionConfirmation: "1",
      name: input.projectName,
      project: input.projectName,
      // `target` accepts only `staging` / `production` / a custom-env id;
      // preview deployments are expressed by OMITTING it.
      ...(input.target === "production" ? { target: "production" } : {}),
      meta: input.meta,
      files: input.artifact.files.map((file) => ({
        file: file.path,
        sha: file.sha1,
        size: file.size,
      })),
      ...(input.artifact.projectSettings !== undefined
        ? { projectSettings: input.artifact.projectSettings }
        : {}),
    });
    const deploymentId = idOf(created);

    // 3. Poll until terminal — Schedule.spaced 2s, ≤45 polls (~90s budget,
    //    speed doctrine; prebuilt deploys are typically ready in seconds).
    let dep: DeploymentSnapshot = created;
    if (!isTerminal(readyStateOf(dep))) {
      dep = yield* deployments
        .getDeployment({ idOrUrl: deploymentId, teamId })
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (d) => isTerminal(readyStateOf(d)),
            times: 45,
          }),
        );
    }

    const readyState = readyStateOf(dep);
    if (readyState === "ERROR" || readyState === "CANCELED") {
      const logs = yield* buildLogTail(deploymentId);
      const errorCode =
        "errorCode" in dep && typeof dep.errorCode === "string"
          ? dep.errorCode
          : undefined;
      return yield* new DeploymentFailed({
        message: `Vercel deployment ${deploymentId} ended ${readyState}${
          errorCode !== undefined ? ` (${errorCode})` : ""
        }${logs.length > 0 ? `:\n${logs.slice(-25).join("\n")}` : ""}`,
        deploymentId,
        readyState,
        ...(errorCode !== undefined ? { errorCode } : {}),
        logs,
      });
    }
    if (readyState !== "READY") {
      return yield* new DeploymentTimeout({
        message: `Vercel deployment ${deploymentId} still ${readyState} after poll budget`,
        deploymentId,
        readyState,
      });
    }

    // 4. Production deploys must land their aliases — bounded re-poll, then
    //    a typed failure carrying Vercel's aliasError.
    let aliasAssigned = Boolean(
      "aliasAssigned" in dep ? dep.aliasAssigned : false,
    );
    if (input.target === "production" && !aliasAssigned) {
      dep = yield* deployments
        .getDeployment({ idOrUrl: deploymentId, teamId })
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (d) =>
              Boolean("aliasAssigned" in d ? d.aliasAssigned : false) ||
              aliasErrorOf(d) !== undefined,
            times: 10,
          }),
        );
      aliasAssigned = Boolean(
        "aliasAssigned" in dep ? dep.aliasAssigned : false,
      );
      const aliasError = aliasErrorOf(dep);
      if (aliasError !== undefined) {
        return yield* new AliasAssignmentFailed({
          message: `Vercel deployment ${deploymentId} alias assignment failed: ${aliasError.message ?? aliasError.code ?? "unknown"}`,
          deploymentId,
          ...(aliasError.code !== undefined ? { code: aliasError.code } : {}),
        });
      }
      if (!aliasAssigned) {
        return yield* new AliasAssignmentFailed({
          message: `Vercel deployment ${deploymentId} aliases not assigned after poll budget`,
          deploymentId,
        });
      }
    }

    return {
      deploymentId,
      deploymentUrl: urlOf(dep),
      aliases: aliasesOf(dep),
      aliasAssigned,
    } satisfies DeployResult;
  });

/**
 * Crash recovery (DESIGN §6.6): find an existing READY deployment for this
 * content hash — a reconcile that died after `createDeployment` but before
 * state persisted is reused instead of duplicated.
 */
export const findDeploymentByContentHash = (input: {
  readonly projectId: string;
  readonly contentHash: string;
}) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    const page = yield* deployments.getDeployments({
      teamId,
      projectId: input.projectId,
      limit: 20,
    });
    return page.deployments.find(
      (d) =>
        d.meta?.alchemyContentHash === input.contentHash &&
        d.readyState === "READY",
    );
  });

/**
 * List this stack/stage/logicalId's own `meta`-stamped deployments in a
 * project (tenant-mode delete, leak census).
 */
export const listOwnDeployments = (input: {
  readonly projectId: string;
  readonly stamp: OwnershipStamp;
}) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    const page = yield* deployments.getDeployments({
      teamId,
      projectId: input.projectId,
      limit: 100,
    });
    return page.deployments.filter(
      (d) =>
        d.meta?.alchemyStack === input.stamp.stack &&
        d.meta?.alchemyStage === input.stamp.stage &&
        d.meta?.alchemyLogicalId === input.stamp.logicalId,
    );
  });

/** Idempotent single-deployment delete. */
export const deleteDeploymentById = (id: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    yield* deployments
      .deleteDeployment({ id, teamId })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
  });

/** Idempotent project delete. */
export const deleteProjectByIdOrName = (idOrName: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    yield* projects
      .deleteProject({ idOrName, teamId })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
  });

/**
 * Read back the project's assigned production domain (DESIGN §6.5 — the
 * computed `https://{name}.vercel.app` is never load-bearing). `undefined`
 * when no production alias exists yet.
 */
export const readProductionUrl = (
  project: projects.GetProjectResponse,
): string | undefined => {
  const aliases = project.alias ?? [];
  const production = aliases.find(
    (a) => String(a.target).toLowerCase() === "production",
  );
  const domain = (production ?? aliases[0])?.domain;
  return domain !== undefined ? `https://${domain}` : undefined;
};

/**
 * Read back the project's assigned production domain from the project
 * domains listing — the pre-deploy complement to {@link readProductionUrl}
 * (a freshly created project's body carries no `alias` rows until its
 * first deployment, but the assigned `{name}.vercel.app` project domain
 * exists from creation). Still a READ-BACK, never computed: `.vercel.app`
 * is a global namespace, so a taken name yields a suffixed domain.
 */
export const readAssignedProductionUrl = (idOrName: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    const body = yield* projects.getProjectDomains({ idOrName, teamId });
    const domains =
      typeof body === "object" && body !== null && "domains" in body
        ? (body.domains as ReadonlyArray<{
            name: string;
            verified: boolean;
            redirect?: string | null;
          }>)
        : [];
    const candidates = domains.filter(
      (d) => d.verified && (d.redirect === undefined || d.redirect === null),
    );
    const assigned =
      candidates.find((d) => d.name.endsWith(".vercel.app")) ?? candidates[0];
    return assigned !== undefined ? `https://${assigned.name}` : undefined;
  });

/** Normalize the `getProjects` response union into a plain project list. */
export const listAllProjects = () =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    const collected: Array<{ id: string; name: string }> = [];
    let until: number | undefined;
    // Bounded pagination: `pagination.next` is a millisecond timestamp fed
    // back as `until`; hard cap 20 pages.
    for (let page = 0; page < 20; page++) {
      const body = yield* projects.getProjects({
        teamId,
        limit: "100",
        ...(until !== undefined ? { until: String(until) } : {}),
      });
      const items: ReadonlyArray<{ id: string; name: string }> = Array.isArray(
        body,
      )
        ? body
        : typeof body === "object" && body !== null && "projects" in body
          ? body.projects
          : [];
      collected.push(...items.map((p) => ({ id: p.id, name: p.name })));
      const next =
        !Array.isArray(body) &&
        typeof body === "object" &&
        body !== null &&
        "pagination" in body
          ? ((body.pagination as { next?: number | null }).next ?? undefined)
          : undefined;
      if (items.length === 0 || next === undefined || next === until) {
        break;
      }
      until = next;
    }
    return collected;
  });
