import * as sql from "@distilled.cloud/azure/sql";
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
  createChildName,
  fieldsMatch,
  isServerOwnedByStack,
  lower,
} from "./common.ts";
import {
  jobAgentPath,
  type JobAgentScope,
  retryWhileAgentBusy,
} from "./setting.ts";

/** When an elastic job runs. */
export interface JobScheduleSpec {
  /** `Once` or `Recurring`. */
  type: "Once" | "Recurring";
  /** Whether the schedule is enabled. */
  enabled?: boolean;
  /** ISO 8601 start time, e.g. `2026-01-01T00:00:00Z`. */
  startTime?: string;
  /** ISO 8601 end time. */
  endTime?: string;
  /** ISO 8601 repeat interval of a recurring job, e.g. `PT1H`. */
  interval?: string;
}

export interface JobProps {
  /** Resource group of the server. Changing it replaces the job. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the job. */
  server: string;
  /** Name of the elastic job agent. Changing it replaces the job. */
  jobAgent: string;
  /**
   * Name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the job.
   */
  name?: string;
  /** Description of the job. */
  description?: string;
  /** When the job runs. Omit for a job that only runs on demand. */
  schedule?: JobScheduleSpec;
}

export interface Job extends Resource<
  "Azure.Sql.Job",
  JobProps,
  {
    /** Name of the job. */
    jobName: string;
    /** ARM resource ID of the job. */
    jobId: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Name of the elastic job agent. */
    jobAgentName: string;
    /** Job description. */
    description: string | undefined;
    /** Latest version of the job (bumped on each change). */
    version: number | undefined;
    /** Schedule type. */
    scheduleType: string | undefined;
    /** Whether the schedule is enabled. */
    scheduleEnabled: boolean | undefined;
  },
  never,
  Providers
> {}

/**
 * An elastic job — a named, optionally scheduled set of T-SQL steps
 * (`Azure.Sql.JobStep`) an elastic job agent runs against target groups.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/elastic-jobs-overview
 *
 * ### Scheduling Jobs
 * **Example:** Hourly job
 * ```typescript
 * const job = yield* Azure.Sql.Job("refresh-stats", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   jobAgent: agent.jobAgentName,
 *   description: "Refresh statistics",
 *   schedule: { type: "Recurring", interval: "PT1H", enabled: true },
 * });
 * ```
 *
 * **Example:** On-demand job
 * ```typescript
 * yield* Azure.Sql.Job("adhoc", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   jobAgent: agent.jobAgentName,
 *   description: "Run manually",
 * });
 * ```
 *
 * @resource
 */
export const Job = Resource<Job>("Azure.Sql.Job");

type Observed = sql.GetJobResponse;

const getChild = (subscriptionId: string, scope: JobAgentScope, name: string) =>
  orUndefinedIfNotFound(
    sql.GetJob({
      ...jobAgentPath(subscriptionId, scope),
      jobName: name,
    }),
  );

const toAttrs = (
  scope: JobAgentScope,
  name: string,
  observed: Observed,
): Job["Attributes"] => ({
  jobName: name,
  jobId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  serverName: scope.serverName,
  jobAgentName: scope.jobAgentName,
  description: observed.properties?.description || undefined,
  version: observed.properties?.version,
  scheduleType: observed.properties?.schedule?.type,
  scheduleEnabled: observed.properties?.schedule?.enabled,
});

export const JobProvider = () =>
  Provider.succeed(Job, {
    stables: [
      "jobName",
      "jobId",
      "resourceGroup",
      "serverName",
      "jobAgentName",
    ],

    // Children of a job agent are removed with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName) ||
        lower(news.jobAgent) !== lower(output.jobAgentName) ||
        (news.name !== undefined && lower(news.name) !== lower(output.jobName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.serverName ?? olds?.server;
      const jobAgentName = output?.jobAgentName ?? olds?.jobAgent;
      if (
        resourceGroup === undefined ||
        serverName === undefined ||
        jobAgentName === undefined
      ) {
        return undefined;
      }
      const scope = { resourceGroup, serverName, jobAgentName };
      const generated = yield* createChildName(id, 128);
      const name = output?.jobName ?? olds?.name ?? generated;
      const observed = yield* getChild(subscriptionId, scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, name, observed);
      return output !== undefined ||
        name === generated ||
        (yield* isServerOwnedByStack(subscriptionId, resourceGroup, serverName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: JobAgentScope = {
        resourceGroup: news.resourceGroup,
        serverName: news.server,
        jobAgentName: news.jobAgent,
      };
      const name =
        news.name ?? output?.jobName ?? (yield* createChildName(id, 128));
      const desired = {
        description: news.description,
        schedule: news.schedule,
      };
      const get = getChild(subscriptionId, scope, name);

      // Observe, then create or converge in one upsert PUT.
      const observed = yield* get;
      if (
        observed === undefined ||
        !fieldsMatch(observed.properties, desired)
      ) {
        yield* retryWhileAgentBusy(
          sql.JobsCreateOrUpdate({
            ...jobAgentPath(subscriptionId, scope),
            jobName: name,
            properties: desired,
          }),
        );
      }
      const fresh = yield* waitForProvisioned(
        `sql elastic job ${name}`,
        get,
        (observed) =>
          fieldsMatch(observed.properties, desired) ? "Succeeded" : "Updating",
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(scope, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        retryWhileAgentBusy(
          sql.DeleteJob({
            ...jobAgentPath(subscriptionId, output),
            jobName: output.jobName,
          }),
        ),
      );
      yield* waitUntilGone(
        `sql elastic job ${output.jobName}`,
        getChild(subscriptionId, output, output.jobName),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
