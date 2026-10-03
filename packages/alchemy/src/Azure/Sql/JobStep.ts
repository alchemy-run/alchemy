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
import { jobPath, type JobScope, retryWhileAgentBusy } from "./setting.ts";

/** Where a job step writes the result set of its script. */
export interface JobStepOutputSpec {
  /** Server of the output database (fully qualified). */
  serverName: string;
  /** Output database. */
  databaseName: string;
  /** Output table. */
  tableName: string;
  /** Output schema. @default "dbo" */
  schemaName?: string;
  /** ARM ID of the job credential used to write the output. */
  credential?: string;
}

/** Retry and timeout behaviour of a job step. */
export interface JobStepExecutionOptionsSpec {
  /** Timeout of one attempt, in seconds. */
  timeoutSeconds?: number;
  /** Number of retries. */
  retryAttempts?: number;
  /** Delay before the first retry, in seconds. */
  initialRetryIntervalSeconds?: number;
  /** Maximum delay between retries, in seconds. */
  maximumRetryIntervalSeconds?: number;
  /** Multiplier applied to the retry delay. */
  retryIntervalBackoffMultiplier?: number;
}

export interface JobStepProps {
  /** Resource group of the server. Changing it replaces the step. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the step. */
  server: string;
  /** Name of the elastic job agent. Changing it replaces the step. */
  jobAgent: string;
  /** Name of the job. Changing it replaces the step. */
  job: string;
  /**
   * Name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the step.
   */
  name?: string;
  /** ARM ID of the target group the step runs against. */
  targetGroup: string;
  /** T-SQL script the step runs. */
  script: string;
  /**
   * ARM ID of the job credential used to connect to targets. Omit when the
   * agent authenticates with a managed identity.
   */
  credential?: string;
  /** Execution order within the job (1-based). Defaults to the next free slot. */
  stepId?: number;
  /** Where to write the script's result set. */
  output?: JobStepOutputSpec;
  /** Retry and timeout behaviour. */
  executionOptions?: JobStepExecutionOptionsSpec;
}

export interface JobStep extends Resource<
  "Azure.Sql.JobStep",
  JobStepProps,
  {
    /** Name of the step. */
    stepName: string;
    /** ARM resource ID of the step. */
    stepId: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Name of the elastic job agent. */
    jobAgentName: string;
    /** Name of the job. */
    jobName: string;
    /** Execution order within the job. */
    stepNumber: number | undefined;
    /** ARM ID of the target group. */
    targetGroup: string;
  },
  never,
  Providers
> {}

/**
 * A step of an elastic job — a T-SQL script run against a target group,
 * with optional result output and retry settings. Each change creates a
 * new job version.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/elastic-jobs-overview
 *
 * ### Adding Steps
 * **Example:** Run a script against a target group
 * ```typescript
 * yield* Azure.Sql.JobStep("update-stats", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   jobAgent: agent.jobAgentName,
 *   job: job.jobName,
 *   targetGroup: targets.targetGroupId,
 *   credential: credential.credentialId,
 *   script: "EXEC sp_updatestats;",
 *   executionOptions: { retryAttempts: 3, timeoutSeconds: 600 },
 * });
 * ```
 *
 * @resource
 */
export const JobStep = Resource<JobStep>("Azure.Sql.JobStep");

type Observed = sql.GetJobStepResponse;

const getChild = (subscriptionId: string, scope: JobScope, name: string) =>
  orUndefinedIfNotFound(
    sql.GetJobStep({
      ...jobPath(subscriptionId, scope),
      stepName: name,
    }),
  );

const toAttrs = (
  scope: JobScope,
  name: string,
  observed: Observed,
): JobStep["Attributes"] => ({
  stepName: name,
  stepId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  serverName: scope.serverName,
  jobAgentName: scope.jobAgentName,
  jobName: scope.jobName,
  stepNumber: observed.properties?.stepId,
  targetGroup: observed.properties?.targetGroup ?? "",
});

export const JobStepProvider = () =>
  Provider.succeed(JobStep, {
    stables: [
      "stepName",
      "stepId",
      "resourceGroup",
      "serverName",
      "jobAgentName",
      "jobName",
    ],

    // Children of a job are removed with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName) ||
        lower(news.jobAgent) !== lower(output.jobAgentName) ||
        lower(news.job) !== lower(output.jobName) ||
        (news.name !== undefined && lower(news.name) !== lower(output.stepName))
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
      const jobName = output?.jobName ?? olds?.job;
      if (
        resourceGroup === undefined ||
        serverName === undefined ||
        jobAgentName === undefined ||
        jobName === undefined
      ) {
        return undefined;
      }
      const scope = { resourceGroup, serverName, jobAgentName, jobName };
      const generated = yield* createChildName(id, 128);
      const name = output?.stepName ?? olds?.name ?? generated;
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
      const scope: JobScope = {
        resourceGroup: news.resourceGroup,
        serverName: news.server,
        jobAgentName: news.jobAgent,
        jobName: news.job,
      };
      const name =
        news.name ?? output?.stepName ?? (yield* createChildName(id, 128));
      const desired = {
        stepId: news.stepId,
        targetGroup: news.targetGroup,
        credential: news.credential,
        action: { type: "TSql", source: "Inline", value: news.script },
        output:
          news.output === undefined
            ? undefined
            : { type: "SqlDatabase", ...news.output },
        executionOptions: news.executionOptions,
      };
      const get = getChild(subscriptionId, scope, name);

      // Observe, then create or converge in one upsert PUT.
      const observed = yield* get;
      if (
        observed === undefined ||
        !fieldsMatch(observed.properties, desired)
      ) {
        yield* retryWhileAgentBusy(
          sql.JobStepsCreateOrUpdate({
            ...jobPath(subscriptionId, scope),
            stepName: name,
            properties: desired,
          }),
        );
      }
      const fresh = yield* waitForProvisioned(
        `sql job step ${name}`,
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
          sql.DeleteJobStep({
            ...jobPath(subscriptionId, output),
            stepName: output.stepName,
          }),
        ),
      );
      yield* waitUntilGone(
        `sql job step ${output.stepName}`,
        getChild(subscriptionId, output, output.stepName),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
