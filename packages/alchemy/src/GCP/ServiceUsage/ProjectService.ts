import * as serviceusage from "@distilled.cloud/gcp/serviceusage_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export type ProjectServiceProps = {
  /** Google Cloud project id. Defaults to the active GCP project. */
  project?: string;
  /** Service identifier, such as `compute.googleapis.com`. */
  service: string;
  /**
   * Disable the API when this resource is destroyed. Leave disabled for APIs
   * shared with resources outside this stack.
   * @default false
   */
  disableOnDestroy?: boolean;
};

export type ProjectService = Resource<
  "GCP.ServiceUsage.ProjectService",
  ProjectServiceProps,
  {
    /** Google Cloud project id. */
    project: string;
    /** Service identifier. */
    service: string;
    /** Current Service Usage consumer state. */
    state: serviceusage.GoogleApiServiceusageV1ServiceStateEnum;
    /** Whether destroy disables the service. */
    disableOnDestroy: boolean;
  },
  never,
  Providers
>;

/**
 * Declaratively enables a Google Cloud API for a project.
 *
 * An API that is already enabled (by another stack, the console, or a
 * dependent service) is adopted as-is; Service Usage has no per-caller
 * ownership marker. By default destroy only releases Alchemy state and
 * leaves the API enabled, matching the safe `google_project_service`
 * configuration used by shared projects. Enable `disableOnDestroy` only for
 * APIs this stack alone relies on: it disables the API project-wide, even
 * when it was enabled before this stack adopted it.
 *
 * ### Enabling Required APIs
 * **Example:** Enable Compute Engine without disabling it on destroy
 * ```typescript
 * const computeApi = yield* GCP.ServiceUsage.ProjectService("ComputeApi", {
 *   service: "compute.googleapis.com",
 *   disableOnDestroy: false,
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Service Usage
 */
export const ProjectService = Resource<ProjectService>(
  "GCP.ServiceUsage.ProjectService",
);

export class ProjectServiceOperationFailed extends Data.TaggedError(
  "GCP.ServiceUsage.ProjectServiceOperationFailed",
)<{
  operation: string;
  code: number | undefined;
  message: string;
}> {}

export class ProjectServiceNotEnabled extends Data.TaggedError(
  "GCP.ServiceUsage.ProjectServiceNotEnabled",
)<{
  project: string;
  service: string;
}> {}

const normalizeService = (service: string) =>
  service.replace(/^services\//, "").replace(/^\/+|\/+$/g, "");

const serviceName = (project: string, service: string) =>
  `projects/${project}/services/${normalizeService(service)}`;

const getService = (project: string, service: string) =>
  serviceusage
    .getServices({ name: serviceName(project, service) })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitOperation = (operation: serviceusage.Operation) =>
  Effect.gen(function* () {
    const name = operation.name ?? "";
    if (name === "" && operation.done !== true) {
      return yield* new ProjectServiceOperationFailed({
        operation: name,
        code: undefined,
        message: "Service Usage operation is missing a name",
      });
    }
    const done =
      operation.done === true
        ? operation
        : yield* serviceusage.getOperations({ name }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (next) => next.done === true,
              times: 10,
            }),
          );
    if (done.done !== true || done.error !== undefined) {
      return yield* new ProjectServiceOperationFailed({
        operation: name,
        code: done.error?.code,
        message:
          done.error?.message ?? "Service Usage operation did not complete",
      });
    }
  });

const toAttrs = (
  project: string,
  service: string,
  state: serviceusage.GoogleApiServiceusageV1ServiceStateEnum,
  disableOnDestroy: boolean,
) => ({
  project,
  service: normalizeService(service),
  state,
  disableOnDestroy,
});

export const ProjectServiceProvider = () =>
  Provider.succeed(ProjectService, {
    stables: ["project", "service"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousProject = olds?.project ?? output?.project;
      const previousService = olds?.service ?? output?.service;
      if (
        (previousProject !== undefined &&
          news.project !== undefined &&
          news.project !== previousProject) ||
        (previousService !== undefined &&
          normalizeService(news.service) !== normalizeService(previousService))
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const project = olds?.project ?? output?.project ?? env.project;
      const service = olds?.service ?? output?.service;
      if (service === undefined) return undefined;
      const current = yield* getService(project, service);
      if (current === undefined || current.state !== "ENABLED")
        return undefined;
      return toAttrs(
        project,
        service,
        current.state,
        olds?.disableOnDestroy ?? output?.disableOnDestroy ?? false,
      );
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      // Preserve the project selected on create when an explicit project prop
      // is later omitted, matching `read` and the stable-property contract.
      const project = news.project ?? output?.project ?? env.project;
      const service = normalizeService(news.service);
      let current = yield* getService(project, service);
      if (current?.state !== "ENABLED") {
        const operation = yield* serviceusage.enableServices({
          name: serviceName(project, service),
          body: {},
        });
        yield* waitOperation(operation);
        current = yield* getService(project, service).pipe(
          Effect.flatMap((value) =>
            value?.state === "ENABLED"
              ? Effect.succeed(value)
              : Effect.fail(new ProjectServiceNotEnabled({ project, service })),
          ),
          Effect.retry({
            while: (error) =>
              error._tag === "GCP.ServiceUsage.ProjectServiceNotEnabled",
            schedule: Schedule.spaced("2 seconds"),
            times: 10,
          }),
        );
      }
      return toAttrs(
        project,
        service,
        current.state ?? "ENABLED",
        news.disableOnDestroy === true,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.disableOnDestroy !== true) return;
      const current = yield* getService(output.project, output.service);
      if (current?.state !== "ENABLED") return;
      const operation = yield* serviceusage.disableServices({
        name: serviceName(output.project, output.service),
        body: {},
      });
      yield* waitOperation(operation);
    }),
  });
