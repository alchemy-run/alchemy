import * as ml from "@distilled.cloud/azure/machinelearningservices";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { containsValue, createChildName, sameArm } from "./Common.ts";

export interface ScheduleAction {
  /** What the schedule does when it fires. */
  actionType: "CreateJob" | "InvokeBatchEndpoint" | "CreateMonitor";
  /**
   * `CreateJob`: the job definition (e.g. a command or pipeline job, as in
   * the Azure ML REST API `JobBase` properties).
   */
  jobDefinition?: Record<string, unknown>;
  /** `CreateMonitor`: the monitor definition. */
  createMonitorRequest?: Record<string, unknown>;
  /** `InvokeBatchEndpoint`: the endpoint invocation definition. */
  endpointInvocationDefinition?: Record<string, unknown>;
}

export interface CronTrigger {
  triggerType: "Cron";
  /** NCrontab expression, e.g. `0 2 * * *`. */
  expression: string;
  /** Time zone of the expression (Windows time zone name). @default "UTC" */
  timeZone?: string;
  /** ISO 8601 start time. */
  startTime?: string;
  /** ISO 8601 end time. */
  endTime?: string;
}

export interface RecurrenceTrigger {
  triggerType: "Recurrence";
  /** Recurrence unit. */
  frequency: "Minute" | "Hour" | "Day" | "Week" | "Month";
  /** Number of units between runs. */
  interval: number;
  /** Optional hours/minutes/weekDays/monthDays filter. */
  schedule?: {
    hours: number[];
    minutes: number[];
    weekDays?: string[];
    monthDays?: number[];
  };
  /** Time zone. @default "UTC" */
  timeZone?: string;
  /** ISO 8601 start time. */
  startTime?: string;
  /** ISO 8601 end time. */
  endTime?: string;
}

export interface ScheduleProps {
  /** Resource group of the workspace. Changing it replaces the schedule. */
  resourceGroup: string;
  /** Workspace that owns the schedule. Changing it replaces the schedule. */
  workspace: string;
  /**
   * Schedule name. If omitted, a unique name is generated from the logical
   * ID. Changing it replaces the schedule.
   */
  name?: string;
  /** What runs when the schedule fires. */
  action: ScheduleAction;
  /** When the schedule fires. */
  trigger: CronTrigger | RecurrenceTrigger;
  /**
   * Whether the schedule fires.
   * @default true
   */
  isEnabled?: boolean;
  /** Display name. */
  displayName?: string;
  /** Description of the schedule. */
  description?: string;
  /**
   * User tags (stored in the schedule body). Alchemy ownership tags are
   * merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Schedule extends Resource<
  "Azure.MachineLearning.Schedule",
  ScheduleProps,
  {
    /** Name of the schedule. */
    scheduleName: string;
    /** ARM resource ID of the schedule. */
    scheduleId: string;
    /** Workspace that owns the schedule. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Whether the schedule fires. */
    isEnabled: boolean;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A schedule in an Azure Machine Learning workspace that submits a job,
 * invokes a batch endpoint, or runs a model monitor on a cron or
 * recurrence trigger.
 *
 * @see https://learn.microsoft.com/azure/machine-learning/how-to-schedule-pipeline-job
 *
 * ### Scheduling a Job
 * **Example:** Nightly command job on serverless compute
 * ```typescript
 * const nightly = yield* Azure.MachineLearning.Schedule("nightly", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   trigger: { triggerType: "Cron", expression: "0 2 * * *" },
 *   action: {
 *     actionType: "CreateJob",
 *     jobDefinition: {
 *       jobType: "Command",
 *       command: "python train.py",
 *       environmentId:
 *         "azureml://registries/azureml/environments/sklearn-1.5/labels/latest",
 *       resources: { instanceType: "Standard_DS3_v2", instanceCount: 1 },
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** Paused weekly schedule
 * ```typescript
 * const weekly = yield* Azure.MachineLearning.Schedule("weekly", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   isEnabled: false,
 *   trigger: {
 *     triggerType: "Recurrence",
 *     frequency: "Week",
 *     interval: 1,
 *     schedule: { hours: [3], minutes: [0], weekDays: ["Monday"] },
 *   },
 *   action: { actionType: "CreateJob", jobDefinition },
 * });
 * ```
 *
 * @resource
 */
export const Schedule = Resource<Schedule>("Azure.MachineLearning.Schedule");

const getSchedule = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    ml.GetSchedule({ subscriptionId, resourceGroupName, workspaceName, name }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  schedule: ml.GetScheduleResponse,
): Schedule["Attributes"] => ({
  scheduleName: name,
  scheduleId: schedule.id ?? "",
  workspace,
  resourceGroup,
  isEnabled: schedule.properties.isEnabled ?? true,
  tags: userTags(schedule.properties.tags ?? undefined),
});

export const ScheduleProvider = () =>
  Provider.succeed(Schedule, {
    stables: ["scheduleName", "scheduleId", "workspace", "resourceGroup"],

    // Schedules are deleted with their workspace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // Parent names are stable upstream; an unresolved one means the
      // parent is being replaced.
      if (!isResolved(news.resourceGroup) || !isResolved(news.workspace)) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.workspace, output.workspace) ||
        (news.name !== undefined && news.name !== output.scheduleName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const name =
        output?.scheduleName ?? olds?.name ?? (yield* createChildName(id, 64));
      const observed = yield* getSchedule(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      return (yield* isOwned(id, observed.properties.tags ?? undefined))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.MachineLearningServices",
      );
      const { resourceGroup, workspace } = news;
      const name =
        news.name ?? output?.scheduleName ?? (yield* createChildName(id, 64));
      const tags = yield* desiredTags(id, news.tags);
      const isEnabled = news.isEnabled ?? true;
      const trigger = { timeZone: "UTC", ...news.trigger };
      const get = getSchedule(subscriptionId, resourceGroup, workspace, name);
      const converged = (schedule: ml.GetScheduleResponse) => {
        const props = schedule.properties;
        return (
          (props.isEnabled ?? true) === isEnabled &&
          (news.displayName === undefined ||
            props.displayName === news.displayName) &&
          (news.description === undefined ||
            props.description === news.description) &&
          containsValue(props.trigger, trigger) &&
          sameArm(props.action.actionType, news.action.actionType) &&
          !tagsDiffer(props.tags ?? undefined, tags)
        );
      };

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is a long-running upsert of the whole
      // schedule. The job definition is normalized by Azure, so it is
      // re-sent whenever any other aspect drifted.
      if (observed === undefined || !converged(observed)) {
        yield* ml.SchedulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          name,
          properties: {
            action: news.action,
            trigger,
            isEnabled,
            displayName: news.displayName,
            description: news.description,
            tags,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `machine learning schedule ${name}`,
        get,
        (schedule) => {
          const state = schedule.properties.provisioningState;
          if (state !== undefined && state !== "Succeeded") return state;
          return converged(schedule) ? "Succeeded" : "Updating";
        },
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, workspace, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        ml.DeleteSchedule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          name: output.scheduleName,
        }),
      );
      yield* waitUntilGone(
        `machine learning schedule ${output.scheduleName}`,
        getSchedule(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.scheduleName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.MachineLearning.Workspace"] },
  });
