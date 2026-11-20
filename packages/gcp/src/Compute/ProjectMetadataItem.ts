import * as compute from "@distilled.cloud/gcp/compute_v1";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { waitGlobalOperation } from "./operations.ts";

export type ProjectMetadataItemProps = {
  /** Project whose common instance metadata holds the key. Defaults to the current GCP project. */
  project?: string;
  /**
   * Metadata key: letters, digits, `-`, or `_`, under 128 bytes (e.g.
   * `enable-oslogin`). Changing it replaces the item.
   */
  key: string;
  /** Metadata value (at most 256 KiB). */
  value: string;
};

export type ProjectMetadataItem = Resource<
  "GCP.Compute.ProjectMetadataItem",
  ProjectMetadataItemProps,
  {
    /** Project whose metadata holds the key. */
    project: string;
    /** Metadata key. */
    key: string;
    /** Metadata value. */
    value: string;
  },
  never,
  Providers
>;

/**
 * One key of a project's common instance metadata — the GCP analog of a
 * Terraform `google_compute_project_metadata_item`. Only this key is
 * managed: every other key is left as it is. Writes are read-modify-write
 * under the metadata fingerprint and retried when another writer changed
 * the metadata first.
 *
 * ### Setting a Key
 * **Example:** Turn on OS Login for every VM in the project
 * ```typescript
 * yield* GCP.Compute.ProjectMetadataItem("OsLogin", {
 *   key: "enable-oslogin",
 *   value: "TRUE",
 * });
 * ```
 *
 * ### Updating a Value
 * **Example:** Change the value in place
 * ```typescript
 * yield* GCP.Compute.ProjectMetadataItem("OsLogin", {
 *   key: "enable-oslogin",
 *   value: "FALSE",
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const ProjectMetadataItem = Resource<ProjectMetadataItem>("GCP.Compute.ProjectMetadataItem");

const getMetadata = (project: string) =>
  compute
    .getProjects({ project })
    .pipe(Effect.map((current) => current.commonInstanceMetadata ?? {}));

/**
 * Rewrite one key under the observed fingerprint (`undefined` removes it).
 * A stale fingerprint fails with 412 `conditionNotMet`; observe again.
 */
const writeItem = (project: string, key: string, value: string | undefined) =>
  Effect.gen(function* () {
    const metadata = yield* getMetadata(project);
    const items = metadata.items ?? [];
    const existing = items.find((item) => item.key === key);
    if (existing?.value === value) return;
    const next = items.filter((item) => item.key !== key);
    if (value !== undefined) next.push({ key, value });
    const operation = yield* compute.setCommonInstanceMetadataProjects({
      project,
      body: { fingerprint: metadata.fingerprint, items: next },
    });
    yield* waitGlobalOperation(project, operation);
  }).pipe(
    Effect.retry({
      while: (error) =>
        (error._tag === "UnknownGCPError" && error.status === 412) ||
        (error._tag === "BadRequest" && /fingerprint/i.test(error.message)),
      times: 8,
      schedule: Schedule.exponential("1 second"),
    }),
  );

export const ProjectMetadataItemProvider = () =>
  Provider.succeed(ProjectMetadataItem, {
    stables: ["project", "key"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousProject = output?.project ?? olds?.project ?? env.project;
      const previousKey = output?.key ?? olds?.key;
      if (
        (news.project ?? env.project) !== previousProject ||
        (previousKey !== undefined && news.key !== previousKey)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const project = output?.project ?? olds?.project ?? env.project;
      const key = output?.key ?? olds?.key;
      if (key === undefined) return undefined;
      const metadata = yield* getMetadata(project);
      const item = metadata.items?.find((entry) => entry.key === key);
      if (item === undefined) return undefined;
      return { project, key, value: item.value ?? "" };
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const env = yield* GcpEnvironment.current;
      const project = news.project ?? env.project;
      yield* writeItem(project, news.key, news.value);
      return { project, key: news.key, value: news.value };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* writeItem(output.project, output.key, undefined).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });
