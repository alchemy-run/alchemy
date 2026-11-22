import * as Schema from "effect/Schema";

export const JobId = Schema.String.annotate({
  description: "The ID of the job",
});

/** One job, stored as one entity in the `Jobs` table. */
export const Job = Schema.Struct({
  id: JobId,
  content: Schema.String,
  createdAt: Schema.String,
});
export type Job = typeof Job.Type;

/** No job has this ID. */
export class JobNotFound extends Schema.TaggedError<JobNotFound>()(
  "JobNotFound",
  { id: JobId },
  { httpApiStatus: 404 },
) {}

/**
 * Table storage refused or failed the call. `reason` is the typed error's
 * tag (e.g. `TablePermissionDenied` while a new role assignment
 * propagates), never the raw Azure message.
 */
export class JobStoreUnavailable extends Schema.TaggedError<JobStoreUnavailable>()(
  "JobStoreUnavailable",
  { reason: Schema.String },
  { httpApiStatus: 503 },
) {}
