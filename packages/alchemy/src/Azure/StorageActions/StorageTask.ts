import * as storageactions from "@distilled.cloud/azure/storageactions";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/** Blob operation a storage task performs on a matching object. */
export type StorageTaskOperationName =
  | "SetBlobTier"
  | "SetBlobTags"
  | "SetBlobImmutabilityPolicy"
  | "SetBlobLegalHold"
  | "SetBlobExpiry"
  | "DeleteBlob"
  | "UndeleteBlob";

/** One operation of a storage task `if` or `else` block. */
export interface StorageTaskOperation {
  /** The operation to perform on the object. */
  name: StorageTaskOperationName;
  /**
   * Operation parameters, e.g. `{ tier: "Cool" }` for `SetBlobTier`.
   */
  parameters?: Record<string, string>;
  /**
   * What to do after the operation succeeds for an object.
   * @default "continue"
   */
  onSuccess?: "continue";
  /**
   * What to do after the operation fails for an object.
   * @default "break"
   */
  onFailure?: "break";
}

/** The conditional program a storage task runs against each object. */
export interface StorageTaskAction {
  /** Operations run on objects matching `condition`. */
  if: {
    /**
     * Condition predicate evaluated per object, e.g.
     * `[[equals(AccessTier, 'Hot')]]`. See https://aka.ms/storagetaskconditions.
     */
    condition: string;
    /** Operations run when the condition is true. */
    operations: StorageTaskOperation[];
  };
  /** Operations run on objects that do not match the condition. */
  else?: {
    /** Operations run when the condition is false. */
    operations: StorageTaskOperation[];
  };
}

/** Managed identity configuration of a storage task. */
export interface StorageTaskIdentity {
  /** Identity type. */
  type:
    | "None"
    | "SystemAssigned"
    | "UserAssigned"
    | "SystemAssigned,UserAssigned";
  /** ARM resource IDs of user-assigned identities to attach. */
  userAssignedIdentities?: string[];
}

export interface StorageTaskProps {
  /**
   * Resource group the storage task is created in. Changing it replaces the
   * task.
   */
  resourceGroup: string;
  /**
   * Name of the storage task, 3-18 lowercase letters and digits. If omitted,
   * a unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the task.
   */
  name?: string;
  /**
   * Azure location of the storage task. Changing it replaces the task.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Whether the task is enabled.
   * @default true
   */
  enabled?: boolean;
  /**
   * Text describing the purpose of the task.
   * @default the logical ID
   */
  description?: string;
  /** The condition/operation program run against each object. */
  action: StorageTaskAction;
  /**
   * Managed identity of the task. Grant this identity `Storage Blob Data
   * Owner` on target storage accounts.
   * @default { type: "SystemAssigned" }
   */
  identity?: StorageTaskIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface StorageTask extends Resource<
  "Azure.StorageActions.StorageTask",
  StorageTaskProps,
  {
    /** Name of the storage task. */
    storageTaskName: string;
    /** Resource group that holds the storage task. */
    resourceGroup: string;
    /**
     * ARM resource ID of the storage task. Use it as the `taskId` of a
     * storage task assignment.
     */
    storageTaskId: string;
    /** Location of the storage task. */
    location: string;
    /** Whether the task is enabled. */
    enabled: boolean;
    /** Description of the task. */
    description: string;
    /** Task version; Azure increments it when the action changes. */
    taskVersion: number | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** Creation time of the task (UTC, ISO 8601). */
    creationTimeInUtc: string | undefined;
    /** Identity type of the task. */
    identityType: string;
    /**
     * Object ID of the task's system-assigned identity, if any. Grant it
     * data access on the target storage accounts.
     */
    principalId: string | undefined;
    /** Microsoft Entra tenant of the system-assigned identity. */
    tenantId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Storage Actions storage task — a serverless, declarative
 * condition/operation program (if/else over blob properties → set tier,
 * set tags, delete, ...) that runs against the storage accounts it is
 * assigned to with a storage task assignment.
 *
 * An unassigned task costs nothing; billing is per task run and objects
 * scanned.
 *
 * @see https://learn.microsoft.com/azure/storage-actions/overview
 *
 * ### Creating a Storage Task
 * **Example:** Move hot blobs to the cool tier
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const task = yield* Azure.StorageActions.StorageTask("tiering", {
 *   resourceGroup: group.resourceGroupName,
 *   description: "Move hot blobs to cool",
 *   action: {
 *     if: {
 *       condition: "[[equals(AccessTier, 'Hot')]]",
 *       operations: [{ name: "SetBlobTier", parameters: { tier: "Cool" } }],
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** Delete temporary blobs, tag everything else
 * ```typescript
 * const task = yield* Azure.StorageActions.StorageTask("cleanup", {
 *   resourceGroup: group.resourceGroupName,
 *   action: {
 *     if: {
 *       condition: "[[endsWith(Name, '.tmp')]]",
 *       operations: [{ name: "DeleteBlob" }],
 *     },
 *     else: {
 *       operations: [
 *         { name: "SetBlobTags", parameters: { reviewed: "true" } },
 *       ],
 *     },
 *   },
 * });
 * ```
 *
 * ### Assigning a Task to a Storage Account
 * **Example:** Grant the task's identity access and assign it
 * ```typescript
 * yield* Azure.Authorization.RoleAssignment("task-access", {
 *   scope: account.storageAccountId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataOwner,
 *   principalId: task.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * @resource
 */
export const StorageTask = Resource<StorageTask>(
  "Azure.StorageActions.StorageTask",
);

type ObservedTask = storageactions.GetStorageTaskResponse;

const createTaskName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 18,
    lowercase: true,
    delimiter: "",
  });
  return name.replace(/[^a-z0-9]/g, "");
});

const getTask = (
  subscriptionId: string,
  resourceGroupName: string,
  storageTaskName: string,
) =>
  orUndefinedIfNotFound(
    storageactions.GetStorageTask({
      subscriptionId,
      resourceGroupName,
      storageTaskName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  task: ObservedTask,
): StorageTask["Attributes"] => ({
  storageTaskName: name,
  resourceGroup,
  storageTaskId: task.id ?? "",
  location: task.location,
  enabled: task.properties.enabled,
  description: task.properties.description,
  taskVersion: task.properties.taskVersion,
  provisioningState: task.properties.provisioningState,
  creationTimeInUtc: task.properties.creationTimeInUtc,
  identityType: task.identity?.type ?? "None",
  principalId: task.identity?.principalId,
  tenantId: task.identity?.tenantId,
  tags: userTags(task.tags),
});

/** Canonical form of an action, with Azure's operation defaults applied. */
const canonicalAction = (action: storageactions.StorageTaskAction) => {
  const ops = (operations: readonly storageactions.StorageTaskOperation[]) =>
    operations.map((op) => ({
      name: op.name,
      parameters: Object.fromEntries(
        Object.entries(op.parameters ?? {})
          .filter(([, value]) => value !== undefined)
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
      onSuccess: op.onSuccess ?? "continue",
      onFailure: op.onFailure ?? "break",
    }));
  return JSON.stringify({
    if: {
      condition: action.if.condition,
      operations: ops(action.if.operations),
    },
    else:
      action.else && action.else.operations.length > 0
        ? { operations: ops(action.else.operations) }
        : null,
  });
};

/**
 * Azure rejects operations without `onSuccess`/`onFailure` ("The storage
 * task action schema is invalid"), so fill in the only allowed values.
 */
const withOperationDefaults = (
  action: StorageTaskAction,
): storageactions.StorageTaskAction => {
  const ops = (operations: readonly StorageTaskOperation[]) =>
    operations.map((op) => ({
      ...op,
      onSuccess: op.onSuccess ?? "continue",
      onFailure: op.onFailure ?? "break",
    }));
  return {
    if: {
      condition: action.if.condition,
      operations: ops(action.if.operations),
    },
    else: action.else ? { operations: ops(action.else.operations) } : undefined,
  };
};

const normalizeIdentityType = (type: string | undefined) =>
  (type ?? "None").replaceAll(" ", "").toLowerCase();

const identityDiffers = (
  observed: ObservedTask["identity"] | undefined,
  desired: StorageTaskIdentity,
) => {
  if (normalizeIdentityType(observed?.type) !== normalizeIdentityType(desired.type)) {
    return true;
  }
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  const want = (desired.userAssignedIdentities ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  return JSON.stringify(have) !== JSON.stringify(want);
};

const toRequestIdentity = (
  identity: StorageTaskIdentity,
): storageactions.CreateStorageTaskRequestIdentity => ({
  type: identity.type,
  userAssignedIdentities:
    identity.userAssignedIdentities && identity.userAssignedIdentities.length > 0
      ? Object.fromEntries(
          identity.userAssignedIdentities.map((id) => [id, {}]),
        )
      : undefined,
});

export const StorageTaskProvider = () =>
  Provider.succeed(StorageTask, {
    stables: ["storageTaskName", "resourceGroup", "storageTaskId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* storageactions
        .ListStorageTaskBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListStorageTaskBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((task) => {
        const group = resourceGroupOf(task.id);
        return hasAnyAlchemyTag(task.tags) &&
          group !== undefined &&
          task.name !== undefined
          ? [toAttrs(group, task.name, task)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.storageTaskName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.replaceAll(" ", "").toLowerCase() !==
            output.location.replaceAll(" ", "").toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.storageTaskName ?? olds?.name ?? (yield* createTaskName(id));
      const observed = yield* getTask(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.StorageActions");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.storageTaskName ?? (yield* createTaskName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const enabled = news.enabled ?? true;
      const description = news.description ?? id;
      const action = withOperationDefaults(news.action);
      const identity = news.identity ?? { type: "SystemAssigned" };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        storageTaskName: name,
      };
      const label = `storage task ${name}`;
      const waitReady = waitForProvisioned(
        label,
        getTask(subscriptionId, resourceGroup, name),
        (task) => task.properties.provisioningState,
        { interval: "3 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* getTask(subscriptionId, resourceGroup, name);

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* storageactions.CreateStorageTask({
          ...where,
          location,
          tags,
          identity: toRequestIdentity(identity),
          properties: { enabled, description, action },
        });
      }
      observed = yield* waitReady;

      // Sync each mutable aspect against observed state; PATCH only deltas.
      const properties: storageactions.StorageTaskUpdatePropertiesInput = {};
      if (observed.properties.enabled !== enabled) properties.enabled = enabled;
      if (observed.properties.description !== description) {
        properties.description = description;
      }
      if (
        canonicalAction(observed.properties.action) !== canonicalAction(action)
      ) {
        properties.action = action;
      }
      const propsChanged = Object.keys(properties).length > 0;
      const identityChanged = identityDiffers(observed.identity, identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (propsChanged || identityChanged || tagsChanged) {
        yield* storageactions.UpdateStorageTask({
          ...where,
          properties: propsChanged ? properties : undefined,
          identity: identityChanged ? toRequestIdentity(identity) : undefined,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storageactions.DeleteStorageTask({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          storageTaskName: output.storageTaskName,
        }),
      );
      yield* waitUntilGone(
        `storage task ${output.storageTaskName}`,
        getTask(subscriptionId, output.resourceGroup, output.storageTaskName),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
