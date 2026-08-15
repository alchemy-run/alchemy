import * as projects from "@distilled.cloud/vercel/projects";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { sensitiveFingerprint } from "../Deploy/Engine.ts";
import type { Providers } from "../Providers.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";

/** Deployment environments a project env var can target. */
export type ProjectEnvTarget = "production" | "preview" | "development";

/** The env var type. `sensitive` values are write-only on Vercel's side. */
export type ProjectEnvType = "plain" | "encrypted" | "sensitive";

/**
 * A per-item failure reported inside the 201-enveloped `failed[]` array of
 * `createProjectEnv` (live-verified: batch failures arrive per-item inside a
 * success status), surfaced as a typed error.
 */
export class ProjectEnvWriteError extends Data.TaggedError(
  "Vercel.ProjectEnvWriteError",
)<{
  readonly code: string;
  readonly message: string;
  readonly key: string | undefined;
}> {}

export interface ProjectEnvProps {
  /**
   * The project the env var lives on: a project id (`prj_…`) or project
   * name. Changing the project replaces the resource.
   */
  project: string;
  /**
   * The environment variable name, e.g. `FLAG`. Changing the key replaces
   * the resource (the new key is created before the old row is removed).
   */
  key: string;
  /**
   * The environment variable value. Pass a `Redacted` value to store it as
   * a `sensitive` env var (write-only on Vercel's side; drift is detected
   * via a content fingerprint persisted in state).
   */
  value: string | Redacted.Redacted<string>;
  /**
   * The variable type. `encrypted` values are decryptable via the API on
   * most accounts; `sensitive` values can never be read back. A `Redacted`
   * `value` forces `sensitive` regardless of this setting.
   *
   * @default "encrypted" ("sensitive" when `value` is Redacted)
   */
  type?: ProjectEnvType;
  /**
   * Deployment environments the variable applies to. Sensitive variables
   * may not target `development` (live-verified: the API rejects it), so
   * `development` is dropped from a sensitive row's targets.
   *
   * @default ["production", "preview", "development"] (sensitive: ["production", "preview"])
   */
  target?: ProjectEnvTarget[];
  /**
   * Git branch scoping for preview-targeted variables. Requires `target`
   * to include `preview`.
   */
  gitBranch?: string;
  /**
   * A comment describing what the variable is for.
   */
  comment?: string;
}

export type ProjectEnv = Resource<
  "Vercel.ProjectEnv",
  ProjectEnvProps,
  {
    /** The project id or name the env var was created on (from props). */
    projectId: string;
    /** The env row id (stable across value updates). */
    envId: string;
    /** The variable name. */
    key: string;
    /** The variable type as reported by Vercel. */
    type: string;
    /** Deployment environments the variable applies to (sorted). */
    target: string[];
    /** Git branch scoping, if any. */
    gitBranch: string | undefined;
    /** The comment, if any. */
    comment: string | undefined;
    /**
     * `alchemy:sha256:<hash>` of the last value written by Alchemy — the
     * drift baseline whenever the cloud value is unobservable (sensitive
     * rows always; encrypted rows returned as `decrypted: false`
     * ciphertext on teams with v2 env encryption).
     */
    fingerprint: string;
    /** Creation time in epoch milliseconds. */
    createdAt: number | undefined;
    /** Last update time in epoch milliseconds. */
    updatedAt: number | undefined;
  },
  never,
  Providers
>;

type ProjectEnvAttributes = ProjectEnv["Attributes"];

/**
 * A single environment variable on a Vercel project.
 *
 * Use this to manage one env var on a project you don't otherwise own —
 * e.g. a feature flag on a `Vercel.Project` whose env is not managed by a
 * compute resource, or a variable on a pre-existing project. (Env vars on a
 * project deployed by `Vercel.Function` are managed by the deploy engine's
 * `env` prop instead — don't mix both for the same key.)
 *
 * @resource
 * @section Creating a project env var
 * @example A feature flag on a project
 * ```typescript
 * const legacy = yield* Vercel.Project("Legacy", {});
 * yield* Vercel.ProjectEnv("LegacyFlag", {
 *   project: legacy.projectId,
 *   key: "FLAG",
 *   value: "on",
 *   target: ["production"],
 * });
 * ```
 *
 * @example A sensitive secret
 * ```typescript
 * import * as Redacted from "effect/Redacted";
 *
 * // Redacted values are stored as `sensitive` — write-only on Vercel's
 * // side; drift is detected via a fingerprint persisted in state. Note
 * // sensitive vars may not target `development`.
 * yield* Vercel.ProjectEnv("ApiKey", {
 *   project: legacy.projectId,
 *   key: "API_KEY",
 *   value: Redacted.make("sk_live_…"),
 * });
 * ```
 *
 * @section Branch-scoped preview variables
 * @example Scope a preview variable to a branch
 * ```typescript
 * yield* Vercel.ProjectEnv("StagingUrl", {
 *   project: legacy.projectId,
 *   key: "API_URL",
 *   value: "https://staging.api.example.com",
 *   target: ["preview"],
 *   gitBranch: "staging",
 * });
 * ```
 *
 * @see https://vercel.com/docs/environment-variables
 */
export const ProjectEnv = Resource<ProjectEnv>("Vercel.ProjectEnv");

const ALL_TARGETS: ProjectEnvTarget[] = [
  "production",
  "preview",
  "development",
];

/**
 * Observed env row (normalized across the response unions' cases). The
 * generated per-operation row types are structurally identical in the
 * fields read here.
 */
interface EnvRow {
  readonly id?: string;
  readonly key: string;
  readonly value?: string;
  readonly type: string;
  readonly comment?: string;
  readonly target?: unknown;
  readonly gitBranch?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
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

/** List a project's env vars, decrypting readable values for diffing. */
const listRows = (idOrName: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    const body = yield* projects.filterProjectEnvs({
      idOrName,
      teamId,
      decrypt: "true",
    });
    return typeof body === "object" && body !== null && "envs" in body
      ? ([...body.envs] as EnvRow[])
      : typeof body === "object" && body !== null && "key" in body
        ? [body as EnvRow]
        : [];
  });

/** The desired wire row derived from props. */
interface DesiredRow {
  readonly key: string;
  readonly value: string;
  readonly type: ProjectEnvType;
  readonly target: ProjectEnvTarget[];
  readonly gitBranch: string | undefined;
  readonly comment: string | undefined;
  readonly fingerprint: string;
}

const desiredRowOf = (news: ProjectEnvProps) =>
  Effect.gen(function* () {
    const isSensitive =
      news.type === "sensitive" || Redacted.isRedacted(news.value);
    const raw = Redacted.isRedacted(news.value)
      ? Redacted.value(news.value)
      : news.value;
    const fingerprint = yield* sensitiveFingerprint(raw);
    const defaults: ProjectEnvTarget[] = isSensitive
      ? ["production", "preview"]
      : ALL_TARGETS;
    // Sensitive rows may never target development (live-verified).
    const target = (news.target ?? defaults).filter(
      (t) => !isSensitive || t !== "development",
    );
    return {
      key: news.key,
      value: raw,
      type: isSensitive ? ("sensitive" as const) : (news.type ?? "encrypted"),
      target,
      gitBranch: news.gitBranch,
      comment: news.comment,
      fingerprint,
    } satisfies DesiredRow;
  });

const toAttributes = (
  project: string,
  row: EnvRow,
  fingerprint: string,
): ProjectEnvAttributes => ({
  projectId: project,
  envId: row.id ?? "",
  key: row.key,
  type: row.type,
  target: targetsOf(row.target),
  gitBranch: row.gitBranch ?? undefined,
  comment: row.comment === "" ? undefined : row.comment,
  fingerprint,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * Resolve the observed row: the persisted id is a cache (not proof of
 * existence); with no id-match, an unambiguous key+gitBranch match recovers
 * a crashed create or an out-of-band id rotation.
 */
const findRow = (
  rows: ReadonlyArray<EnvRow>,
  envId: string | undefined,
  key: string,
  gitBranch: string | undefined,
): EnvRow | undefined => {
  const byId =
    envId !== undefined ? rows.find((row) => row.id === envId) : undefined;
  if (byId !== undefined) return byId;
  const matches = rows.filter(
    (row) => row.key === key && (row.gitBranch ?? undefined) === gitBranch,
  );
  // Ambiguity (several rows sharing key+branch across disjoint targets) is
  // unresolvable without an id — treat as not found.
  return matches.length === 1 ? matches[0] : undefined;
};

const failFromEnvelope = (
  failed: ReadonlyArray<{
    error: { code: string; message: string; key?: string; envVarKey?: string };
  }>,
) => {
  const first = failed[0];
  return first !== undefined
    ? Effect.fail(
        new ProjectEnvWriteError({
          code: first.error.code,
          message: first.error.message,
          key: first.error.envVarKey ?? first.error.key,
        }),
      )
    : Effect.void;
};

export const ProjectEnvProvider = () =>
  Provider.succeed(ProjectEnv, {
    stables: ["projectId", "envId", "key", "createdAt"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const oldProject = output?.projectId ?? olds?.project;
      if (oldProject !== undefined && news.project !== oldProject) {
        return { action: "replace" } as const;
      }
      const oldKey = output?.key ?? olds?.key;
      if (oldKey !== undefined && news.key !== oldKey) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const project = output?.projectId ?? olds?.project;
      const key = output?.key ?? olds?.key;
      if (project === undefined || key === undefined) return undefined;
      return yield* listRows(project).pipe(
        Effect.map((rows) => {
          const row = findRow(
            rows,
            output?.envId,
            key,
            output?.gitBranch ?? olds?.gitBranch,
          );
          return row !== undefined
            ? toAttributes(project, row, output?.fingerprint ?? "")
            : undefined;
        }),
        // Project gone (404s as the status-class NotFound) → row gone.
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const { teamId } = yield* VercelEnvironment.current;
      const desired = yield* desiredRowOf(news);

      // Observe — the cloud row is authoritative for everything readable.
      const rows = yield* listRows(news.project);
      const observed = findRow(rows, output?.envId, news.key, news.gitBranch);

      // Ensure + sync in one write: `createProjectEnv?upsert=true` is a
      // true upsert keyed on key+target+branch, so both the missing-row
      // and the drifted-row paths converge with the same call. Per-item
      // failures arrive inside the success envelope's `failed[]`
      // (live-verified) and must be surfaced as typed errors.
      const drifted =
        observed === undefined ||
        observed.type !== desired.type ||
        targetsOf(observed.target).join(",") !==
          [...desired.target].sort().join(",") ||
        (observed.gitBranch ?? undefined) !== desired.gitBranch ||
        ((observed.comment === "" ? undefined : observed.comment) ??
          undefined) !== commentFor(desired) ||
        (desired.type === "sensitive" || observed.decrypted === false
          ? // Value unobservable — diff the persisted fingerprint.
            output?.fingerprint !== desired.fingerprint
          : observed.value !== desired.value);

      if (!drifted && observed !== undefined) {
        return toAttributes(news.project, observed, desired.fingerprint);
      }

      const response = yield* projects.createProjectEnv({
        idOrName: news.project,
        teamId,
        upsert: "true",
        body: [
          {
            key: desired.key,
            value: desired.value,
            type: desired.type,
            target: desired.target,
            ...(desired.gitBranch !== undefined
              ? { gitBranch: desired.gitBranch }
              : {}),
            ...(commentFor(desired) !== undefined
              ? { comment: commentFor(desired) }
              : {}),
          },
        ],
      });
      yield* failFromEnvelope(response.failed);
      const createdRows = Array.isArray(response.created)
        ? response.created
        : [response.created];
      const created = createdRows[0] as EnvRow | undefined;
      if (created !== undefined) {
        return toAttributes(news.project, created, desired.fingerprint);
      }
      // Defensive: an empty envelope (no created row, no failure) — fall
      // back to re-observing the row we just wrote.
      const after = findRow(
        yield* listRows(news.project),
        output?.envId,
        news.key,
        news.gitBranch,
      );
      if (after === undefined) {
        return yield* Effect.die(
          `Vercel createProjectEnv for '${news.key}' on ${news.project} returned neither a created row nor a failure, and the row is not visible`,
        );
      }
      return toAttributes(news.project, after, desired.fingerprint);
    }),
    delete: Effect.fn(function* ({ output }) {
      const { teamId } = yield* VercelEnvironment.current;
      if (output.envId === "") return;
      // Already gone (out-of-band delete, or a re-run after a state
      // persistence failure) is success, not an error. A deleted host
      // project also surfaces as NotFound.
      yield* projects
        .removeProjectEnv({
          idOrName: output.projectId,
          id: output.envId,
          teamId,
        })
        .pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }),
  });

/**
 * The comment that ships on the wire: the user's comment when given; for
 * sensitive rows without one, the value fingerprint (a human-visible hint
 * in the dashboard — nothing depends on reading it back).
 */
const commentFor = (desired: DesiredRow): string | undefined =>
  desired.comment ??
  (desired.type === "sensitive" ? desired.fingerprint : undefined);
