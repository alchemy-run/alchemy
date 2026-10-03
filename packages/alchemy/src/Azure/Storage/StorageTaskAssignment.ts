import * as storage from "@distilled.cloud/azure/storage";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
import { isAccountOwnedByStack } from "./StorageOwnership.ts";

/** When a storage task assignment runs. */
export interface StorageTaskTrigger {
  /** `RunOnce` (at `startOn`) or `OnSchedule` (every `interval` days). */
  type: "RunOnce" | "OnSchedule";
  /** ISO 8601 time of the single run. Required for `RunOnce`. */
  startOn?: string;
  /** ISO 8601 time of the first scheduled run. Required for `OnSchedule`. */
  startFrom?: string;
  /** Run interval. Required for `OnSchedule`. */
  interval?: number;
  /**
   * Unit of `interval`. Required for `OnSchedule`.
   * @default "Days" (for `OnSchedule`)
   */
  intervalUnit?: "Days";
  /** ISO 8601 time after which no more runs start. Required for `OnSchedule`. */
  endBy?: string;
}

export interface StorageTaskAssignmentProps {
  /** Resource group of the storage account. Changing it replaces the assignment. */
  resourceGroup: string;
  /** Storage account the task runs against. Changing it replaces the assignment. */
  storageAccount: string;
  /**
   * Assignment name: 3-24 lowercase letters and digits. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the assignment.
   */
  name?: string;
  /**
   * ARM resource ID of the `Microsoft.StorageActions/storageTasks` task to
   * run. Changing it replaces the assignment. The task's managed identity
   * needs a data role (e.g. `Storage Blob Data Owner`) on the account.
   */
  taskId: string;
  /**
   * Whether the assignment is enabled.
   * @default true
   */
  enabled?: boolean;
  /**
   * Description of the assignment.
   * @default "Managed by Alchemy"
   */
  description?: string;
  /** When the task runs. */
  trigger: StorageTaskTrigger;
  /**
   * Object prefixes (`container/path`) the task runs against.
   * @default all objects
   */
  prefix?: string[];
  /**
   * Object prefixes excluded from the run; they win over `prefix`.
   * @default []
   */
  excludePrefix?: string[];
  /**
   * Container (and optional path) in this account where execution reports
   * are written, e.g. `"reports"`.
   */
  reportPrefix: string;
}

export interface StorageTaskAssignment extends Resource<
  "Azure.Storage.StorageTaskAssignment",
  StorageTaskAssignmentProps,
  {
    /** Name of the assignment. */
    storageTaskAssignmentName: string;
    /** Storage account the task runs against. */
    storageAccount: string;
    /** Resource group of the storage account. */
    resourceGroup: string;
    /** ARM resource ID of the assignment. */
    storageTaskAssignmentId: string;
    /** ARM resource ID of the assigned storage task. */
    taskId: string;
    /** Whether the assignment is enabled. */
    enabled: boolean;
    /** Description of the assignment. */
    description: string;
    /** Trigger type, `RunOnce` or `OnSchedule`. */
    triggerType: string;
    /** Container prefix where execution reports are written. */
    reportPrefix: string;
    /** Provisioning state of the assignment. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Assigns a Storage Actions task (`Microsoft.StorageActions/storageTasks`)
 * to a Storage account so it runs over the account's blobs, once or on a
 * schedule, writing execution reports to a container in the account.
 *
 * The task's system-assigned identity needs a data role on the account
 * (typically `Storage Blob Data Owner`) before the assignment can run.
 *
 * @see https://learn.microsoft.com/azure/storage-actions/storage-tasks/storage-task-assignment-create
 *
 * ### Assigning a Storage Task
 * **Example:** Run a task once
 * ```typescript
 * const reports = yield* Azure.Storage.BlobContainer("reports", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 * });
 * yield* Azure.Storage.StorageTaskAssignment("cleanup", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   taskId: storageTaskId,
 *   reportPrefix: reports.containerName,
 *   trigger: { type: "RunOnce", startOn: "2030-01-01T00:00:00Z" },
 * });
 * ```
 *
 * **Example:** Run a task every week on a prefix
 * ```typescript
 * yield* Azure.Storage.StorageTaskAssignment("weekly-cleanup", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   taskId: storageTaskId,
 *   reportPrefix: reports.containerName,
 *   prefix: ["logs/"],
 *   trigger: {
 *     type: "OnSchedule",
 *     startFrom: "2030-01-01T00:00:00Z",
 *     endBy: "2031-01-01T00:00:00Z",
 *     interval: 7,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const StorageTaskAssignment = Resource<StorageTaskAssignment>(
  "Azure.Storage.StorageTaskAssignment",
);

const createAssignmentName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 24,
    lowercase: true,
    delimiter: "",
  });
  return name.replace(/[^a-z0-9]/g, "");
});

const getAssignment = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  storageTaskAssignmentName: string,
) =>
  orUndefinedIfNotFound(
    storage.GetStorageTaskAssignment({
      subscriptionId,
      resourceGroupName,
      accountName,
      storageTaskAssignmentName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  storageAccount: string,
  name: string,
  observed: storage.GetStorageTaskAssignmentResponse,
): StorageTaskAssignment["Attributes"] => ({
  storageTaskAssignmentName: name,
  storageAccount,
  resourceGroup,
  storageTaskAssignmentId: observed.id ?? "",
  taskId: observed.properties?.taskId ?? "",
  enabled: observed.properties?.enabled ?? false,
  description: observed.properties?.description ?? "",
  triggerType: observed.properties?.executionContext.trigger.type ?? "",
  reportPrefix: observed.properties?.report.prefix ?? "",
  provisioningState: observed.properties?.provisioningState,
});

const instant = (value: string | undefined) =>
  value === undefined ? undefined : new Date(value).getTime();

const sameList = (
  observed: ReadonlyArray<string> | undefined,
  desired: ReadonlyArray<string> | undefined,
) =>
  JSON.stringify([...(observed ?? [])].sort()) ===
  JSON.stringify([...(desired ?? [])].sort());

const desiredProperties = (news: StorageTaskAssignmentProps) => {
  const { trigger } = news;
  return {
    taskId: news.taskId,
    enabled: news.enabled ?? true,
    description: news.description ?? "Managed by Alchemy",
    executionContext: {
      target:
        news.prefix === undefined && news.excludePrefix === undefined
          ? undefined
          : { prefix: news.prefix, excludePrefix: news.excludePrefix },
      trigger: {
        type: trigger.type,
        parameters:
          trigger.type === "RunOnce"
            ? { startOn: trigger.startOn }
            : {
                startFrom: trigger.startFrom,
                interval: trigger.interval,
                intervalUnit: trigger.intervalUnit ?? "Days",
                endBy: trigger.endBy,
              },
      },
    },
    report: { prefix: news.reportPrefix },
  } satisfies storage.StorageTaskAssignmentPropertiesInput;
};

const differs = (
  observed: storage.StorageTaskAssignmentProperties | undefined,
  desired: ReturnType<typeof desiredProperties>,
) => {
  if (observed === undefined) return true;
  const o = observed.executionContext;
  const d = desired.executionContext;
  const op = o.trigger.parameters;
  const dp = d.trigger.parameters as storage.TriggerParameters;
  return (
    observed.taskId.toLowerCase() !== desired.taskId.toLowerCase() ||
    observed.enabled !== desired.enabled ||
    observed.description !== desired.description ||
    observed.report.prefix !== desired.report.prefix ||
    o.trigger.type !== d.trigger.type ||
    instant(op.startOn) !== instant(dp.startOn) ||
    instant(op.startFrom) !== instant(dp.startFrom) ||
    instant(op.endBy) !== instant(dp.endBy) ||
    op.interval !== dp.interval ||
    !sameList(o.target?.prefix, d.target?.prefix) ||
    !sameList(o.target?.excludePrefix, d.target?.excludePrefix)
  );
};

export const StorageTaskAssignmentProvider = () =>
  Provider.succeed(StorageTaskAssignment, {
    stables: [
      "storageTaskAssignmentName",
      "storageAccount",
      "resourceGroup",
      "storageTaskAssignmentId",
    ],

    // Assignments disappear with their storage account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.storageAccount !== output.storageAccount ||
        (news.name !== undefined &&
          news.name !== output.storageTaskAssignmentName) ||
        news.taskId.toLowerCase() !== output.taskId.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const storageAccount = output?.storageAccount ?? olds?.storageAccount;
      if (resourceGroup === undefined || storageAccount === undefined) {
        return undefined;
      }
      const name =
        output?.storageTaskAssignmentName ??
        olds?.name ??
        (yield* createAssignmentName(id));
      const observed = yield* getAssignment(
        subscriptionId,
        resourceGroup,
        storageAccount,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, storageAccount, name, observed);
      return (yield* isAccountOwnedByStack(
        subscriptionId,
        resourceGroup,
        storageAccount,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const { resourceGroup, storageAccount } = news;
      const name =
        news.name ??
        output?.storageTaskAssignmentName ??
        (yield* createAssignmentName(id));
      const get = getAssignment(
        subscriptionId,
        resourceGroup,
        storageAccount,
        name,
      );
      const desired = desiredProperties(news);

      // Observe; the PUT is a full upsert (create or update), so only send
      // it when the observed assignment differs.
      const observed = yield* get;
      if (differs(observed?.properties, desired)) {
        yield* storage
          .CreateStorageTaskAssignment({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: storageAccount,
            storageTaskAssignmentName: name,
            properties: desired,
          })
          .pipe(
            // The previous async PUT may still be settling after GET reports
            // Succeeded.
            Effect.retry({
              while: (e) =>
                e._tag === "StorageTaskAssignmentOperationInProgress",
              schedule: Schedule.spaced("5 seconds"),
              times: 24,
            }),
          );
      }

      const fresh = yield* waitForProvisioned(
        `storage task assignment ${name}`,
        get,
        (value) => value.properties?.provisioningState,
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceGroup, storageAccount, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storage
          .DeleteStorageTaskAssignment({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.storageAccount,
            storageTaskAssignmentName: output.storageTaskAssignmentName,
          })
          .pipe(
            Effect.retry({
              while: (e) =>
                e._tag === "StorageTaskAssignmentOperationInProgress",
              schedule: Schedule.spaced("5 seconds"),
              times: 24,
            }),
          ),
      );
      yield* waitUntilGone(
        `storage task assignment ${output.storageTaskAssignmentName}`,
        getAssignment(
          subscriptionId,
          output.resourceGroup,
          output.storageAccount,
          output.storageTaskAssignmentName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Storage.StorageAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
