import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";
import { JobNotFound } from "./Job.ts";
import { JobApi } from "./JobApi.ts";
import { JobStorage } from "./JobStorage.ts";

/** The handlers for every endpoint of {@link JobApi}. */
const JobsLive = HttpApiBuilder.group(JobApi, "Jobs", (handlers) =>
  Effect.gen(function* () {
    const storage = yield* JobStorage;

    return handlers
      .handle("createJob", ({ payload }) =>
        Effect.sync(() => ({
          id: crypto.randomUUID(),
          content: payload.content,
          createdAt: new Date().toISOString(),
        })).pipe(Effect.flatMap((job) => storage.putJob(job))),
      )
      .handle("getJob", ({ params }) =>
        storage
          .getJob(params.id)
          .pipe(
            Effect.flatMap((job) =>
              job === undefined
                ? Effect.fail(new JobNotFound({ id: params.id }))
                : Effect.succeed(job),
            ),
          ),
      )
      .handle("listJobs", () => storage.listJobs())
      .handle("deleteJob", ({ params }) => storage.deleteJob(params.id))
      .handle("health", () => Effect.succeed("ok"));
  }),
);

/** The router layer: the API plus its handlers. */
export const JobApiLive = HttpApiBuilder.layer(JobApi).pipe(Layer.provide(JobsLive));
