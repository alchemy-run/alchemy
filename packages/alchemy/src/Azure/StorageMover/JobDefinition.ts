import * as storagemover from "@distilled.cloud/azure/storagemover";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createMoverName,
  DELETE_BUDGET,
  describe,
  isOwnedByDescription,
  userDescription,
} from "./Common.ts";

export type JobDefinitionCopyMode = "Additive" | "Mirror";

export type JobDefinitionJobType =
  | "OnPremToCloud"
  | "CloudToCloud"
  | "OnPremToCloudAgentLess";

export type JobDefinitionDataIntegrityValidation =
  | "SaveVerifyFileMD5"
  | "SaveFileMD5"
  | "None";

export interface JobDefinitionSchedule {
  /** How often the job runs. */
  frequency?: "Monthly" | "Weekly" | "Daily" | "Onetime" | "None" | "Hourly";
  /** Whether the schedule is active. */
  isActive?: boolean;
  /** Time of day to run (`hour` 0-24, `minute` 0 or 30). */
  executionTime?: { hour?: number; minute?: number };
  /** Start date and time (ISO 8601, UTC). */
  startDate?: string;
  /** End date and time (ISO 8601, UTC). */
  endDate?: string;
  /** Days of the week for weekly schedules, e.g. `["Monday"]`. */
  daysOfWeek?: string[];
  /** Days of the month for monthly schedules. */
  daysOfMonth?: number[];
  /** CRON expression for advanced scheduling. */
  cronExpression?: string;
  /** Repeat interval for sub-daily schedules (ISO 8601 duration). */
  repeatInterval?: string;
}

export interface JobDefinitionProps {
  /** Resource group of the Storage Mover. Changing it replaces the job definition. */
  resourceGroup: string;
  /** Storage Mover that holds the project. Changing it replaces the job definition. */
  storageMover: string;
  /** Project that holds the job definition. Changing it replaces the job definition. */
  project: string;
  /**
   * Name of the job definition: 1-64 letters, digits, `-` and `_`, starting
   * with a letter or digit. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the job definition.
   */
  name?: string;
  /**
   * Copy strategy: `Additive` only adds and updates files in the target;
   * `Mirror` also deletes target files missing from the source.
   */
  copyMode: JobDefinitionCopyMode;
  /** Name of the source endpoint. Changing it replaces the job definition. */
  sourceName: string;
  /** Subpath to read from the source endpoint. Changing it replaces the job definition. */
  sourceSubpath?: string;
  /** Name of the target endpoint. Changing it replaces the job definition. */
  targetName: string;
  /** Subpath to write to in the target endpoint. Changing it replaces the job definition. */
  targetSubpath?: string;
  /**
   * Migration type. Changing it replaces the job definition.
   * @default "OnPremToCloud"
   */
  jobType?: JobDefinitionJobType;
  /** Whether to preserve file permissions. Changing it replaces the job definition. */
  preservePermissions?: boolean;
  /** Whether the counterpart endpoint lives in another tenant. Changing it replaces the job definition. */
  isCrossTenantJob?: boolean;
  /** Tenant ID of the cross-tenant endpoint. Changing it replaces the job definition. */
  crossTenantEndpointTenantId?: string;
  /** ARM ID of the cross-tenant endpoint. Changing it replaces the job definition. */
  crossTenantEndpointResourceId?: string;
  /**
   * Description of the job definition. Alchemy appends an ownership marker
   * (`[alchemy <stack>/<stage>/<id>]`) because job definitions have no tags.
   */
  description?: string;
  /** Name of the agent that runs new job runs. Only needed to start a job. */
  agentName?: string;
  /** ARM IDs of Storage Mover connections the job uses. */
  connections?: string[];
  /** Schedule for recurring job runs. */
  schedule?: JobDefinitionSchedule;
  /** Checksum validation mode. */
  dataIntegrityValidation?: JobDefinitionDataIntegrityValidation;
}

export interface JobDefinition extends Resource<
  "Azure.StorageMover.JobDefinition",
  JobDefinitionProps,
  {
    /** Name of the job definition. */
    jobDefinitionName: string;
    /** Project that holds the job definition. */
    project: string;
    /** Storage Mover that holds the project. */
    storageMover: string;
    /** Resource group of the Storage Mover. */
    resourceGroup: string;
    /** ARM resource ID of the job definition. */
    jobDefinitionId: string;
    /** Description of the job definition (ownership marker stripped). */
    description: string | undefined;
    /** Copy strategy. */
    copyMode: string;
    /** ARM ID of the source endpoint. */
    sourceResourceId: string | undefined;
    /** ARM ID of the target endpoint. */
    targetResourceId: string | undefined;
    /** ARM ID of the assigned agent, if any. */
    agentResourceId: string | undefined;
    /** Name of the latest non-terminal job run, if any. */
    latestJobRunName: string | undefined;
    /** Status of the latest non-terminal job run, if any. */
    latestJobRunStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Storage Mover job definition — what to copy (a source endpoint and
 * subpath), where to (a target endpoint and subpath), and how (copy mode,
 * schedule, integrity validation). Starting a job run also needs an agent.
 *
 * Job definitions have no tags, so Alchemy records ownership as a marker at
 * the end of the description.
 *
 * @see https://learn.microsoft.com/azure/storage-mover/job-definition-create
 *
 * ### Creating a Job Definition
 * **Example:** Copy an NFS share into a blob container
 * ```typescript
 * const job = yield* Azure.StorageMover.JobDefinition("copy-data", {
 *   resourceGroup: group.resourceGroupName,
 *   storageMover: mover.storageMoverName,
 *   project: project.projectName,
 *   copyMode: "Additive",
 *   sourceName: source.endpointName,
 *   targetName: target.endpointName,
 *   targetSubpath: "imported",
 * });
 * ```
 *
 * **Example:** Mirror nightly with checksum validation
 * ```typescript
 * const job = yield* Azure.StorageMover.JobDefinition("nightly", {
 *   resourceGroup: group.resourceGroupName,
 *   storageMover: mover.storageMoverName,
 *   project: project.projectName,
 *   copyMode: "Mirror",
 *   sourceName: source.endpointName,
 *   targetName: target.endpointName,
 *   agentName: "agent-01",
 *   dataIntegrityValidation: "SaveVerifyFileMD5",
 *   schedule: {
 *     frequency: "Daily",
 *     isActive: true,
 *     executionTime: { hour: 2, minute: 0 },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const JobDefinition = Resource<JobDefinition>(
  "Azure.StorageMover.JobDefinition",
);

type ObservedJob = storagemover.GetJobDefinitionResponse;

const getJob = (
  subscriptionId: string,
  resourceGroupName: string,
  storageMoverName: string,
  projectName: string,
  jobDefinitionName: string,
) =>
  orUndefinedIfNotFound(
    storagemover.GetJobDefinition({
      subscriptionId,
      resourceGroupName,
      storageMoverName,
      projectName,
      jobDefinitionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  storageMover: string,
  project: string,
  name: string,
  job: ObservedJob,
): JobDefinition["Attributes"] => ({
  jobDefinitionName: name,
  project,
  storageMover,
  resourceGroup,
  jobDefinitionId: job.id ?? "",
  description: userDescription(job.properties.description),
  copyMode: job.properties.copyMode,
  sourceResourceId: job.properties.sourceResourceId,
  targetResourceId: job.properties.targetResourceId,
  agentResourceId: job.properties.agentResourceId,
  latestJobRunName: job.properties.latestJobRunName,
  latestJobRunStatus: job.properties.latestJobRunStatus,
});

const sortedIds = (ids: readonly string[] | undefined) =>
  JSON.stringify([...(ids ?? [])].map((id) => id.toLowerCase()).sort());

/** True when any field set in `desired` differs from `observed`. */
const scheduleDiffers = (
  observed: storagemover.ScheduleInfo | undefined,
  desired: JobDefinitionSchedule,
) =>
  Object.entries(desired).some(
    ([key, value]) =>
      value !== undefined &&
      JSON.stringify(value) !==
        JSON.stringify(
          (observed as Record<string, unknown> | undefined)?.[key],
        ),
  );

export const JobDefinitionProvider = () =>
  Provider.succeed(JobDefinition, {
    stables: [
      "jobDefinitionName",
      "project",
      "storageMover",
      "resourceGroup",
      "jobDefinitionId",
    ],

    // Job definitions are deleted with their project and Storage Mover.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.storageMover.toLowerCase() !== output.storageMover.toLowerCase() ||
        news.project.toLowerCase() !== output.project.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.jobDefinitionName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      if (olds !== undefined) {
        const immutable = [
          "sourceName",
          "sourceSubpath",
          "targetName",
          "targetSubpath",
          "jobType",
          "preservePermissions",
          "isCrossTenantJob",
          "crossTenantEndpointTenantId",
          "crossTenantEndpointResourceId",
        ] as const;
        if (immutable.some((key) => news[key] !== olds[key])) {
          return { action: "replace" } as const;
        }
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const storageMover = output?.storageMover ?? olds?.storageMover;
      const project = output?.project ?? olds?.project;
      if (
        resourceGroup === undefined ||
        storageMover === undefined ||
        project === undefined
      ) {
        return undefined;
      }
      const name =
        output?.jobDefinitionName ?? olds?.name ?? (yield* createMoverName(id));
      const observed = yield* getJob(
        subscriptionId,
        resourceGroup,
        storageMover,
        project,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        storageMover,
        project,
        name,
        observed,
      );
      return (yield* isOwnedByDescription(id, observed.properties.description))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.StorageMover");
      const { resourceGroup, storageMover, project } = news;
      const name =
        news.name ?? output?.jobDefinitionName ?? (yield* createMoverName(id));
      const description = yield* describe(id, news.description);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        storageMoverName: storageMover,
        projectName: project,
        jobDefinitionName: name,
      };
      const get = getJob(
        subscriptionId,
        resourceGroup,
        storageMover,
        project,
        name,
      );

      // Observe.
      const observed = yield* get;

      if (observed === undefined) {
        // Ensure.
        yield* storagemover.JobDefinitionsCreateOrUpdate({
          ...where,
          properties: {
            description,
            copyMode: news.copyMode,
            sourceName: news.sourceName,
            sourceSubpath: news.sourceSubpath,
            targetName: news.targetName,
            targetSubpath: news.targetSubpath,
            jobType: news.jobType,
            preservePermissions: news.preservePermissions,
            isCrossTenantJob: news.isCrossTenantJob,
            crossTenantEndpointTenantId: news.crossTenantEndpointTenantId,
            crossTenantEndpointResourceId: news.crossTenantEndpointResourceId,
            agentName: news.agentName,
            connections: news.connections,
            schedule: news.schedule,
            dataIntegrityValidation: news.dataIntegrityValidation,
          },
        });
      } else {
        // Sync the mutable aspects against the observed job definition.
        const props = observed.properties;
        const delta: storagemover.JobDefinitionUpdateProperties = {};
        if (props.description !== description) delta.description = description;
        if (props.copyMode !== news.copyMode) delta.copyMode = news.copyMode;
        if (
          news.agentName !== undefined &&
          props.agentName !== news.agentName
        ) {
          delta.agentName = news.agentName;
        }
        if (
          news.connections !== undefined &&
          sortedIds(props.connections) !== sortedIds(news.connections)
        ) {
          delta.connections = news.connections;
        }
        if (
          news.schedule !== undefined &&
          scheduleDiffers(props.schedule, news.schedule)
        ) {
          delta.schedule = news.schedule;
        }
        if (
          news.dataIntegrityValidation !== undefined &&
          props.dataIntegrityValidation !== news.dataIntegrityValidation
        ) {
          delta.dataIntegrityValidation = news.dataIntegrityValidation;
        }
        if (Object.keys(delta).length > 0) {
          yield* storagemover.UpdateJobDefinition({
            ...where,
            properties: delta,
          });
        }
      }

      const fresh = yield* waitForProvisioned(
        `storage mover job definition ${name}`,
        get,
        (job) => job.properties.provisioningState,
      );
      return toAttrs(resourceGroup, storageMover, project, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storagemover.DeleteJobDefinition({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          storageMoverName: output.storageMover,
          projectName: output.project,
          jobDefinitionName: output.jobDefinitionName,
        }),
      );
      yield* waitUntilGone(
        `storage mover job definition ${output.jobDefinitionName}`,
        getJob(
          subscriptionId,
          output.resourceGroup,
          output.storageMover,
          output.project,
          output.jobDefinitionName,
        ),
        DELETE_BUDGET,
      );
    }),
  });
