import * as resources from "@distilled.cloud/azure/resources";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import {
  descriptionWithMarker,
  descriptionWithoutMarker,
  MARKER,
  ownershipMarker,
} from "../Authorization/Ownership.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { sameId, sameJson } from "./Shared.ts";

export type ManagementLockLevel = "CanNotDelete" | "ReadOnly";

export interface ManagementLockProps {
  /**
   * ARM ID of the locked scope — a subscription (`/subscriptions/{id}`), a
   * resource group (`group.resourceGroupId`), or a single resource.
   * Changing it replaces the lock.
   */
  scope: string;
  /**
   * Name of the lock, unique within the scope. At most 90 characters,
   * without `<>*%&:\?+/`. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the lock.
   */
  name?: string;
  /**
   * `CanNotDelete` lets users read and modify but not delete the scope;
   * `ReadOnly` also blocks every write (including tag updates) on it.
   */
  level: ManagementLockLevel;
  /**
   * Notes about the lock (at most 512 characters including the marker).
   * Alchemy appends an ownership marker (`[alchemy <stack>/<stage>/<id>]`)
   * because locks have no tags.
   */
  notes?: string;
  /** Application IDs of the lock's owners. */
  ownerApplicationIds?: string[];
}

export interface ManagementLock extends Resource<
  "Azure.Resources.ManagementLock",
  ManagementLockProps,
  {
    /** Name of the lock. */
    lockName: string;
    /** ARM ID, `{scope}/providers/Microsoft.Authorization/locks/{name}`. */
    lockId: string;
    /** Locked scope. */
    scope: string;
    /** Lock level. */
    level: string;
    /** User notes (ownership marker removed). */
    notes: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure management lock — prevents a subscription, resource group, or
 * resource from being deleted (`CanNotDelete`) or changed at all
 * (`ReadOnly`).
 *
 * Locks cannot be tagged, so Alchemy records ownership as a
 * `[alchemy <stack>/<stage>/<id>]` marker at the end of the notes. On
 * destroy the lock is deleted before the locked scope. A `ReadOnly` lock
 * also blocks tag updates on its scope, so Alchemy cannot update the
 * locked resource while the lock exists.
 *
 * @see https://learn.microsoft.com/azure/azure-resource-manager/management/lock-resources
 *
 * ### Locking a Resource Group
 * **Example:** Prevent accidental deletion of a resource group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("prod");
 * yield* Azure.Resources.ManagementLock("prod-lock", {
 *   scope: group.resourceGroupId,
 *   level: "CanNotDelete",
 *   notes: "Production data",
 * });
 * ```
 *
 * ### Locking a Resource
 * **Example:** Make a storage account read-only
 * ```typescript
 * yield* Azure.Resources.ManagementLock("archive-lock", {
 *   scope: account.storageAccountId,
 *   level: "ReadOnly",
 * });
 * ```
 *
 * @resource
 */
export const ManagementLock = Resource<ManagementLock>(
  "Azure.Resources.ManagementLock",
);

const lockNameOf = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, maxLength: 90 });

const getLock = (scope: string, lockName: string) =>
  orUndefinedIfNotFound(resources.GetManagementLockByScope({ scope, lockName }));

/** `{scope}/providers/Microsoft.Authorization/locks/{name}` → scope. */
const scopeOf = (lockId: string) =>
  lockId.replace(/\/providers\/Microsoft\.Authorization\/locks\/[^/]+$/i, "");

const toAttrs = (
  scope: string,
  name: string,
  observed: resources.ManagementLockObject,
): ManagementLock["Attributes"] => ({
  lockName: name,
  lockId:
    observed.id ?? `${scope}/providers/Microsoft.Authorization/locks/${name}`,
  scope,
  level: observed.properties.level,
  notes: descriptionWithoutMarker(observed.properties.notes),
});

export const ManagementLockProvider = () =>
  Provider.succeed(ManagementLock, {
    stables: ["lockName", "lockId", "scope"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // Lists locks at the subscription and every scope below it.
      const page = yield* resources
        .ListManagementLockAtSubscriptionLevel({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListManagementLockAtSubscriptionLevel", page),
          ),
        );
      return (page.value ?? []).flatMap((lock) =>
        lock.id !== undefined &&
        lock.name !== undefined &&
        MARKER.test(lock.properties.notes ?? "")
          ? [toAttrs(scopeOf(lock.id), lock.name, lock)]
          : [],
      );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      if (!isResolved(news.scope)) return { action: "replace" } as const;
      if (!isResolved(news)) return undefined;
      if (
        !sameId(news.scope, output.scope) ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.lockName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const scope = output?.scope ?? olds?.scope;
      if (scope === undefined) return undefined;
      const name = output?.lockName ?? (yield* lockNameOf(id, olds?.name));
      const observed = yield* getLock(scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, name, observed);
      const marker = yield* ownershipMarker(id);
      return (observed.properties.notes ?? "").endsWith(marker)
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Authorization");
      const scope = news.scope;
      const name = output?.lockName ?? (yield* lockNameOf(id, news.name));
      const notes = descriptionWithMarker(
        news.notes,
        yield* ownershipMarker(id),
      );
      const owners = (news.ownerApplicationIds ?? []).map((applicationId) => ({
        applicationId,
      }));

      // Observe.
      const observed = yield* getLock(scope, name);

      // Ensure + sync. The PUT is a full, idempotent write; skip it when
      // level, notes and owners already match.
      const current = observed?.properties;
      if (
        current === undefined ||
        current.level !== news.level ||
        current.notes !== notes ||
        !sameJson(
          (current.owners ?? []).map((o) => o.applicationId),
          owners.map((o) => o.applicationId),
        )
      ) {
        yield* resources.ManagementLocksCreateOrUpdateByScope({
          scope,
          lockName: name,
          properties: {
            level: news.level,
            notes,
            owners: owners.length > 0 ? owners : undefined,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `management lock ${name}`,
        getLock(scope, name),
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(scope, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        resources.DeleteManagementLockByScope({
          scope: output.scope,
          lockName: output.lockName,
        }),
      );
      yield* waitUntilGone(
        `management lock ${output.lockName}`,
        getLock(output.scope, output.lockName),
      );
    }),

    nuke: {
      // The locked scopes can only be deleted once their locks are gone.
      dependsOn: ["Azure.*"],
    },
  });
