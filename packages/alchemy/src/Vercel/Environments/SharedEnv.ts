import {
  createSharedEnvVariable,
  deleteSharedEnvVariable,
  getSharedEnvVar,
  listSharedEnvVariable,
  updateSharedEnvVariable,
} from "@distilled.cloud/vercel/environment";
import { createHash } from "node:crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";

/** Deployment environments a shared env var can target. */
export type SharedEnvTarget = "production" | "preview" | "development";

/**
 * A reference to a project the shared env var is linked to: a project id
 * (`prj_…`) or any resource carrying a `projectId` attribute (e.g.
 * `Vercel.Project`).
 */
export type SharedEnvProjectSource = string | { projectId: string };

/**
 * A per-item failure reported inside the 200-enveloped `failed[]` array of
 * the shared env var create/update/delete APIs, surfaced as a typed error.
 */
export class SharedEnvVarError extends Data.TaggedError("SharedEnvVarError")<{
  readonly code: string;
  readonly message: string;
  readonly key: string | undefined;
}> {}

export interface SharedEnvProps {
  /**
   * The environment variable name, e.g. `API_URL`. Renaming updates the
   * variable in place (the id is stable).
   */
  key: string;
  /**
   * The environment variable value. For `type: "encrypted"` (the default)
   * the value can be read back and drift is corrected from observed cloud
   * state; for `type: "sensitive"` the value is write-only on Vercel's side
   * and drift is detected via a content hash persisted in state.
   */
  value: string;
  /**
   * The variable type. `"encrypted"` values are decryptable by the API;
   * `"sensitive"` values can never be read back (and cannot be converted
   * back to `"encrypted"` once written).
   *
   * @default "encrypted"
   */
  type?: "encrypted" | "sensitive";
  /**
   * Deployment environments the variable applies to.
   *
   * @default ["production", "preview", "development"]
   */
  target?: SharedEnvTarget[];
  /**
   * Projects the variable is linked to. Accepts `Vercel.Project` resources
   * or project ids. Adding/removing entries links/unlinks the variable
   * declaratively.
   */
  projects?: SharedEnvProjectSource[];
  /**
   * A comment describing what the variable is for.
   */
  comment?: string;
}

export type SharedEnv = Resource<
  "Vercel.SharedEnv",
  SharedEnvProps,
  {
    /** The shared env var id (`env_…`). Stable across updates. */
    sharedEnvId: string;
    /** The variable name. */
    key: string;
    /** The variable type as reported by Vercel. */
    type: "encrypted" | "plain" | "sensitive" | "system";
    /** Deployment environments the variable applies to. */
    target: SharedEnvTarget[];
    /** Ids of the projects the variable is linked to. */
    projectIds: string[];
    /** The comment, if any. */
    comment: string | undefined;
    /**
     * sha256 of the last value written by Alchemy. Used to detect value
     * drift for `sensitive` variables, whose values can never be read back.
     */
    valueHash: string;
    /** Creation time in epoch milliseconds. */
    createdAt: number | undefined;
    /** Last update time in epoch milliseconds. */
    updatedAt: number | undefined;
  },
  never,
  Providers
>;

type SharedEnvAttributes = SharedEnv["Attributes"];

/**
 * A Vercel Shared Environment Variable: a team-level env var defined once
 * and linked to any number of projects, applied to the selected deployment
 * targets of each linked project.
 *
 * @resource
 * @section Creating a shared env var
 * @example Link a variable to a project
 * ```typescript
 * const project = yield* Vercel.Project("my-app", {});
 * const flag = yield* Vercel.SharedEnv("ApiUrl", {
 *   key: "API_URL",
 *   value: "https://api.example.com",
 *   projects: [project],
 * });
 * ```
 *
 * @example Production-only sensitive secret
 * ```typescript
 * const secret = yield* Vercel.SharedEnv("SigningKey", {
 *   key: "SIGNING_KEY",
 *   value: signingKey,
 *   type: "sensitive",
 *   target: ["production"],
 *   projects: [project],
 * });
 * ```
 *
 * @section Linking and unlinking projects
 * @example Declarative project links
 * ```typescript
 * // Adding/removing entries in `projects` links/unlinks the variable on
 * // the next deploy — the full list is reconciled against observed state.
 * const flag = yield* Vercel.SharedEnv("ApiUrl", {
 *   key: "API_URL",
 *   value: "https://api.example.com",
 *   projects: [projectA, projectB],
 * });
 * ```
 *
 * @see https://vercel.com/docs/environment-variables/shared-environment-variables
 */
export const SharedEnv = Resource<SharedEnv>("Vercel.SharedEnv");

const DEFAULT_TARGET: SharedEnvTarget[] = [
  "production",
  "preview",
  "development",
];

/**
 * Structural shape shared by every shared-env-var response item (get, list
 * data item, create `created[]` item, update `updated[]` item) — the
 * generated types are per-operation but identical in the fields we read.
 */
interface SharedEnvVarShape {
  readonly id?: string;
  readonly key?: string;
  readonly type?: "encrypted" | "plain" | "sensitive" | "system";
  readonly target?: ReadonlyArray<SharedEnvTarget>;
  readonly projectId?: ReadonlyArray<string>;
  readonly comment?: string;
  readonly value?: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

const teamScope = Effect.gen(function* () {
  const { teamId } = yield* VercelEnvironment.current;
  return teamId !== undefined ? { teamId } : {};
});

const resolveProjectId = (source: SharedEnvProjectSource): string => {
  if (typeof source === "string") return source;
  if (source && "projectId" in source && source.projectId) {
    return source.projectId as unknown as string;
  }
  throw new Error(
    "Invalid Vercel project source: must be a Project or a project id",
  );
};

const hashValue = (value: string) =>
  Effect.sync(() => createHash("sha256").update(value).digest("hex"));

const sameMembers = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean => {
  const as = [...(a ?? [])].sort();
  const bs = [...(b ?? [])].sort();
  return as.length === bs.length && as.every((v, i) => v === bs[i]);
};

const toAttributes = (
  env: SharedEnvVarShape,
  valueHash: string,
): SharedEnvAttributes => ({
  sharedEnvId: env.id ?? "",
  key: env.key ?? "",
  type: env.type ?? "encrypted",
  target: [...(env.target ?? [])],
  projectIds: [...(env.projectId ?? [])],
  comment: env.comment,
  valueHash,
  createdAt: env.createdAt,
  updatedAt: env.updatedAt,
});

/**
 * Surface per-item failures from the create/update/delete 200-envelope as a
 * typed error (the APIs report partial failures inside the body). Codes in
 * `ignore` (e.g. `id_not_found` on an idempotent delete) are tolerated.
 */
const failFromEnvelope = (
  failed: ReadonlyArray<{
    error: { code: string; message: string; key?: string; envVarKey?: string };
  }>,
  ignore: ReadonlyArray<string> = [],
) => {
  const first = failed.find((f) => !ignore.includes(f.error.code));
  return first
    ? Effect.fail(
        new SharedEnvVarError({
          code: first.error.code,
          message: first.error.message,
          key: first.error.key ?? first.error.envVarKey,
        }),
      )
    : Effect.void;
};

/**
 * Single-page exact-key lookup (the list API exposes no pagination inputs).
 * Used to recover a create whose state persistence failed, and to resolve
 * the create-race (`Conflict`) path.
 */
const findByKey = (key: string) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    const res = yield* listSharedEnvVariable({ search: key, ...team });
    const matches = res.data.filter((item) => item.key === key);
    // Ambiguity (several vars sharing the key across disjoint targets) is
    // unresolvable without an id — treat as not found.
    return matches.length === 1 ? matches[0] : undefined;
  });

export const SharedEnvProvider = () =>
  Provider.succeed(SharedEnv, {
    stables: ["sharedEnvId", "createdAt"],
    read: Effect.fn(function* ({ olds, output }) {
      const team = yield* teamScope;
      if (output?.sharedEnvId) {
        return yield* getSharedEnvVar({ id: output.sharedEnvId, ...team }).pipe(
          Effect.map((env) => toAttributes(env, output.valueHash)),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      }
      // State-loss recovery: shared env vars carry no stamp; an unambiguous
      // exact key match from the prior props is the only usable identity.
      if (!olds?.key) return undefined;
      const match = yield* findByKey(olds.key);
      // An empty valueHash marks the value as unknown, so the next
      // reconcile rewrites it from props.
      return match !== undefined ? toAttributes(match, "") : undefined;
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const team = yield* teamScope;
      const desiredTarget = news.target ?? DEFAULT_TARGET;
      const desiredProjectIds = (news.projects ?? []).map(resolveProjectId);
      const desiredType = news.type ?? "encrypted";
      const valueHash = yield* hashValue(news.value);

      // Observe — the persisted id is a cache, not proof of existence; with
      // no id, an unambiguous exact key match recovers a crashed create.
      let observed: SharedEnvVarShape | undefined = output?.sharedEnvId
        ? yield* getSharedEnvVar({ id: output.sharedEnvId, ...team }).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          )
        : yield* findByKey(news.key);

      // Ensure — missing → create with the full desired shape. A Conflict
      // (`existing_key_and_target`) means the key sprang into existence
      // between observe and create — a race; re-observe and fall through to
      // sync it instead.
      if (observed === undefined) {
        const created = yield* createSharedEnvVariable({
          evs: [
            {
              key: news.key,
              value: news.value,
              ...(news.comment !== undefined ? { comment: news.comment } : {}),
            },
          ],
          type: desiredType,
          target: desiredTarget,
          ...(desiredProjectIds.length > 0
            ? { projectId: desiredProjectIds }
            : {}),
          ...team,
        }).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* failFromEnvelope(created.failed);
          const item = created.created[0];
          if (item === undefined) {
            return yield* Effect.die(
              "Vercel createSharedEnvVariable returned neither a created item nor a failure",
            );
          }
          return toAttributes(item, valueHash);
        }
        observed = yield* findByKey(news.key);
        if (observed === undefined) {
          return yield* Effect.die(
            `Vercel rejected creating shared env var "${news.key}" as already existing, but no unambiguous variable with that key is visible`,
          );
        }
      }

      // Sync — diff observed cloud state against desired, PATCH only the
      // delta. The observed value is readable for `encrypted` vars; for
      // `sensitive` ones it is write-only, so drift falls back to the
      // persisted content hash.
      const valueDrifted =
        observed.value !== undefined
          ? observed.value !== news.value
          : output?.valueHash !== valueHash;
      const delta = {
        ...(observed.key !== news.key ? { key: news.key } : {}),
        ...(valueDrifted ? { value: news.value } : {}),
        ...((observed.type ?? "encrypted") !== desiredType
          ? { type: desiredType }
          : {}),
        ...(!sameMembers(observed.target, desiredTarget)
          ? { target: desiredTarget }
          : {}),
        ...(!sameMembers(observed.projectId, desiredProjectIds)
          ? { projectId: desiredProjectIds }
          : {}),
        ...((observed.comment ?? undefined) !== (news.comment ?? undefined)
          ? { comment: news.comment ?? "" }
          : {}),
      };
      const id = observed.id;
      if (id === undefined) {
        return yield* Effect.die(
          "Vercel shared env var response is missing its id",
        );
      }
      if (Object.keys(delta).length > 0) {
        const updated = yield* updateSharedEnvVariable({
          updates: { [id]: delta },
          ...team,
        });
        yield* failFromEnvelope(updated.failed);
        const item = updated.updated[0];
        if (item !== undefined) return toAttributes(item, valueHash);
      }
      return toAttributes(observed, valueHash);
    }),
    delete: Effect.fn(function* ({ output }) {
      const team = yield* teamScope;
      const res = yield* deleteSharedEnvVariable({
        ids: [output.sharedEnvId],
        ...team,
      }).pipe(
        // Already gone (out-of-band delete, or a re-run after a state
        // persistence failure) is success, not an error.
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
      if (res !== undefined) {
        yield* failFromEnvelope(res.failed, ["id_not_found"]);
      }
    }),
    // Team-wide enumeration in one call (the API exposes no pagination
    // inputs for this endpoint).
    list: Effect.fn(function* () {
      const team = yield* teamScope;
      const res = yield* listSharedEnvVariable({ ...team });
      return res.data.map((item) => toAttributes(item, ""));
    }),
  });
