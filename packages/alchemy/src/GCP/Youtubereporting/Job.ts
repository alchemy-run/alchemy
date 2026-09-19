import * as youtubereporting from "@distilled.cloud/gcp/youtubereporting_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  findOwnedJob,
  getJob,
  hasOwnershipMarker,
  ignoreMissing,
  listOwnedJobs,
  ownedByAlchemy,
  ownedName,
  parseName,
  sameText,
} from "./internal.ts";

export type JobProps = {
  /**
   * Server-assigned job id (max 40 characters). Omit on create; pass
   * the observed id to keep the same job. Immutable — changing it
   * replaces the job.
   */
  jobId?: string;
  /**
   * Human-readable job name (max 100 characters including Alchemy's
   * ownership marker). Jobs have no labels field, so Alchemy stamps
   * ownership into a `[alchemy …]` prefix and strips it from
   * attributes. The Reporting API cannot update a job — changing the
   * name replaces it.
   */
  name?: string;
  /**
   * Report type id this job generates (for example
   * `channel_basic_a2`). Call `reportTypes.list` for types available
   * to the authenticated channel or content owner. Immutable —
   * changing it replaces the job.
   */
  reportTypeId: string;
  /**
   * Content owner id to act on behalf of. When omitted, the
   * authenticated user acts for their own channel. Immutable —
   * changing it replaces the job.
   */
  onBehalfOfContentOwner?: string;
};

export type Job = Resource<
  "GCP.Youtubereporting.Job",
  JobProps,
  {
    /** Server-assigned job id. */
    jobId: string;
    /** Project id used when the job was reconciled. */
    project: string;
    /** User-facing name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
    /** Report type id this job generates. */
    reportTypeId: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 expiration timestamp. */
    expireTime: string | undefined;
    /** True when YouTube manages this job (not user-deletable). */
    systemManaged: boolean | undefined;
    /** Content owner id used for API calls, if any. */
    onBehalfOfContentOwner: string | undefined;
  },
  never,
  Providers
>;

/**
 * A YouTube Reporting job that generates a daily report of a given
 * type for a channel or content owner.
 *
 * Jobs have no labels field and no update method — Alchemy stamps
 * ownership into `name` for `list` / nuke, and any identity or
 * definition change replaces the job. Creating jobs requires a YouTube
 * OAuth token with `yt-analytics.readonly` (or
 * `yt-analytics-monetary.readonly`) rather than a project service
 * account.
 *
 * ### Creating a Job
 * **Example:** Channel basic report
 * ```typescript
 * const job = yield* GCP.Youtubereporting.Job("Daily", {
 *   reportTypeId: "channel_basic_a2",
 * });
 * ```
 *
 * **Example:** Named job for a content owner
 * ```typescript
 * const job = yield* GCP.Youtubereporting.Job("Daily", {
 *   name: "alchemy-daily",
 *   reportTypeId: "channel_basic_a2",
 *   onBehalfOfContentOwner: "CONTENT_OWNER_ID",
 * });
 * ```
 *
 * ### Replacing a Job
 * **Example:** Change the report type (replaces — no update API)
 * ```typescript
 * const job = yield* GCP.Youtubereporting.Job("Daily", {
 *   name: "alchemy-daily",
 *   reportTypeId: "channel_demographics_a1",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Youtubereporting
 */
export const Job = Resource<Job>("GCP.Youtubereporting.Job");

export class JobNotResolved extends Data.TaggedError(
  "GCP.Youtubereporting.JobNotResolved",
)<{
  jobId: string;
}> {}

const toAttrs = (
  row: youtubereporting.Job,
  project: string,
  onBehalfOfContentOwner: string | undefined,
) => ({
  jobId: row.id ?? "",
  project,
  name: parseName(row.name).name,
  reportTypeId: row.reportTypeId,
  createTime: row.createTime,
  expireTime: row.expireTime,
  systemManaged: row.systemManaged,
  onBehalfOfContentOwner,
});

export const JobProvider = () =>
  Provider.succeed(Job, {
    stables: ["jobId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.jobId ?? output?.jobId;
      if (
        previousId !== undefined &&
        news.jobId !== undefined &&
        news.jobId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousOwner =
        olds?.onBehalfOfContentOwner ?? output?.onBehalfOfContentOwner;
      if (
        news.onBehalfOfContentOwner !== undefined &&
        previousOwner !== undefined &&
        news.onBehalfOfContentOwner !== previousOwner
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousType = olds?.reportTypeId ?? output?.reportTypeId;
      if (previousType !== undefined && news.reportTypeId !== previousType) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousName = olds?.name ?? output?.name;
      if (
        news.name !== undefined &&
        previousName !== undefined &&
        !sameText(news.name, previousName)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const onBehalfOfContentOwner =
        olds?.onBehalfOfContentOwner ?? output?.onBehalfOfContentOwner;
      let existing = yield* getJob(
        olds?.jobId ?? output?.jobId,
        onBehalfOfContentOwner,
      );
      if (existing === undefined) {
        existing = yield* findOwnedJob(id, onBehalfOfContentOwner);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, onBehalfOfContentOwner);
      return (yield* ownedByAlchemy(id, existing.name))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const rows = yield* listOwnedJobs();
        return rows
          .filter((row) => hasOwnershipMarker(row.name))
          .map((row) => toAttrs(row, env.project, undefined));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const onBehalfOfContentOwner =
        news.onBehalfOfContentOwner ?? output?.onBehalfOfContentOwner;
      const name = yield* ownedName(
        id,
        news.name,
        parseName(output?.name).name ?? output?.name,
      );
      const reportTypeId = news.reportTypeId;

      let current = yield* getJob(
        news.jobId ?? output?.jobId,
        onBehalfOfContentOwner,
      );
      if (current === undefined) {
        current = yield* findOwnedJob(id, onBehalfOfContentOwner);
      }

      if (current === undefined) {
        const created = yield* youtubereporting
          .createJobs({
            onBehalfOfContentOwner,
            body: {
              name,
              reportTypeId,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwnedJob(id, onBehalfOfContentOwner),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined || !current.id) {
        return yield* new JobNotResolved({
          jobId: news.jobId ?? output?.jobId ?? name,
        });
      }

      return toAttrs(current, env.project, onBehalfOfContentOwner);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.jobId) return;
      yield* ignoreMissing(
        youtubereporting.deleteJobs({
          jobId: output.jobId,
          onBehalfOfContentOwner: output.onBehalfOfContentOwner,
        }),
      );
    }),
  });
