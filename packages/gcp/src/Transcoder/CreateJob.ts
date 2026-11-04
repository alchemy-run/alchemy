import * as transcoder from "@distilled.cloud/gcp/transcoder_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { lastSegment, parentOfName } from "./internal.ts";
import type { JobTemplate } from "./JobTemplate.ts";

export interface CreateJobRequest extends Omit<
  transcoder.CreateProjectsLocationsJobsRequest,
  "parent"
> {}

/**
 * Runtime binding for Transcoder `jobs.create`.
 *
 * Starts a transcoding job in the template's location. When `body.config`
 * is omitted, `templateId` is filled from the bound {@link JobTemplate}.
 * Provide {@link CreateJobHttp}.
 *
 * Grants `roles/transcoder.editor` on the project because Transcoder has
 * no resource-level IAM and no narrower predefined role carries
 * `transcoder.jobs.create` (`roles/transcoder.viewer` is read-only).
 *
 * ### Creating a Job
 * **Example:** Transcode with the bound template
 * ```typescript
 * const createJob = yield* GCP.Transcoder.CreateJob(template);
 * const job = yield* createJob({
 *   body: {
 *     inputUri: "gs://bucket/inputs/file.mp4",
 *     outputUri: "gs://bucket/outputs/",
 *   },
 * });
 * ```
 *
 * @binding
 * @category Transcoder
 */
export interface CreateJob extends Binding.Service<
  CreateJob,
  "GCP.Transcoder.CreateJob",
  (
    template: JobTemplate,
  ) => Effect.Effect<
    (
      request?: CreateJobRequest,
    ) => Effect.Effect<transcoder.Job, transcoder.CreateProjectsLocationsJobsError, RuntimeContext>
  >
> {}

export const CreateJob = Binding.Service<CreateJob>("GCP.Transcoder.CreateJob");

/**
 * HTTP implementation of {@link CreateJob}.
 *
 * @layer
 * @provides GCP.Transcoder.CreateJob
 */
export const CreateJobHttp = Layer.effect(
  CreateJob,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const createProjectsLocationsJobs = yield* GCPBindings.withCredentials(
      transcoder.createProjectsLocationsJobs,
    );
    return Effect.fn(function* (template: JobTemplate) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.Transcoder.CreateJob(${template})`({
          // Narrowest predefined role with transcoder.jobs.create; Transcoder
          // has no resource-level IAM, so this is a project grant.
          iam: [{ role: "roles/transcoder.editor" }],
        });
      }
      const name = yield* template.name;
      const location = yield* template.location;
      return Effect.fn(`GCP.Transcoder.CreateJob(${template.LogicalId})`)(function* (
        request?: CreateJobRequest,
      ) {
        const templateName = yield* name;
        const templateLocation = yield* location;
        const templateId = lastSegment(templateName);
        const config = request?.body?.config;
        return yield* createProjectsLocationsJobs({
          parent: parentOfName(templateName, templateLocation),
          body: {
            ...request?.body,
            templateId:
              request?.body?.templateId ?? (config === undefined ? templateId : undefined),
          },
        });
      });
    });
  }),
);
