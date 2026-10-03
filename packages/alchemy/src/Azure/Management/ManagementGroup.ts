import * as management from "@distilled.cloud/azure/management";
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

export interface ManagementGroupProps {
  /**
   * Management group ID (its name), unique in the tenant: up to 90
   * letters, digits, `-`, `_`, `.`, `(` and `)`. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the group.
   */
  name?: string;
  /**
   * Friendly name shown in the portal.
   * @default the group name
   */
  displayName?: string;
  /**
   * Parent management group: its ARM ID
   * (`/providers/Microsoft.Management/managementGroups/{name}`) or bare
   * name, e.g. `parent.managementGroupId`. Changing it moves the group in
   * place.
   * @default the tenant root group
   */
  parentId?: string;
}

export interface ManagementGroup extends Resource<
  "Azure.Management.ManagementGroup",
  ManagementGroupProps,
  {
    /** Management group name (ID). */
    groupName: string;
    /**
     * ARM ID of the management group,
     * `/providers/Microsoft.Management/managementGroups/{name}`.
     */
    managementGroupId: string;
    /** Microsoft Entra tenant that holds the group. */
    tenantId: string;
    /** Friendly name of the group. */
    displayName: string;
    /** ARM ID of the parent management group. */
    parentId: string;
  },
  never,
  Providers
> {}

/**
 * An Azure management group — a tenant-level container that organizes
 * subscriptions (and other management groups) so policies and role
 * assignments can be applied to all of them at once.
 *
 * Management groups live above subscriptions, so the identity running the
 * deploy needs `Microsoft.Management/managementGroups/write` on the parent
 * group (by default any principal may create groups under the tenant root).
 * Management groups cannot be tagged: Alchemy recognises its own groups by
 * their generated name, so an explicit `name` that already exists is only
 * taken over with `--adopt`.
 *
 * @see https://learn.microsoft.com/azure/governance/management-groups/overview
 *
 * ### Creating a Management Group
 * **Example:** Group under the tenant root
 * ```typescript
 * const platform = yield* Azure.Management.ManagementGroup("platform", {
 *   displayName: "Platform",
 * });
 * ```
 *
 * ### Building a Hierarchy
 * **Example:** Nested management groups
 * ```typescript
 * const platform = yield* Azure.Management.ManagementGroup("platform", {
 *   displayName: "Platform",
 * });
 * const prod = yield* Azure.Management.ManagementGroup("prod", {
 *   displayName: "Production",
 *   parentId: platform.managementGroupId,
 * });
 * ```
 *
 * @resource
 */
export const ManagementGroup = Resource<ManagementGroup>(
  "Azure.Management.ManagementGroup",
);

const PREFIX = "/providers/Microsoft.Management/managementGroups/";

/** Full ARM ID of a management group from its ARM ID or bare name. */
export const managementGroupIdOf = (nameOrId: string) =>
  nameOrId.startsWith("/") ? nameOrId : `${PREFIX}${nameOrId}`;

/** Bare management group name from its ARM ID or name. */
export const managementGroupNameOf = (nameOrId: string) =>
  nameOrId.replace(/\/+$/, "").split("/").pop() ?? nameOrId;

const sameId = (a: string, b: string) =>
  managementGroupIdOf(a).replace(/\/+$/, "").toLowerCase() ===
  managementGroupIdOf(b).replace(/\/+$/, "").toLowerCase();

const getGroup = (groupId: string) =>
  orUndefinedIfNotFound(
    management
      .GetManagementGroup({ groupId })
      .pipe(
        Effect.catchTag("ManagementGroupNotFound", () =>
          Effect.succeed(undefined),
        ),
      ),
  );

/**
 * Read a group the caller may have just written. The creator's implicit
 * Owner grant on a new group takes minutes to propagate, during which reads
 * (and deletes) fail with `AuthorizationFailed`; report those as "not yet
 * visible". The PUT is an upsert, so treating it as missing is safe.
 */
const getGroupAfterWrite = (groupId: string) =>
  getGroup(groupId).pipe(
    Effect.catchTag("AuthorizationFailed", () => Effect.succeed(undefined)),
  );

const generatedName = (id: string, instanceId: string) =>
  createPhysicalName({ id, instanceId, maxLength: 90 });

const toAttrs = (
  name: string,
  tenantId: string,
  group: management.GetManagementGroupResponse,
): ManagementGroup["Attributes"] => ({
  groupName: name,
  managementGroupId: group.id ?? `${PREFIX}${name}`,
  tenantId: group.properties?.tenantId ?? tenantId,
  displayName: group.properties?.displayName ?? name,
  parentId: group.properties?.details?.parent?.id ?? `${PREFIX}${tenantId}`,
});

export const ManagementGroupProvider = () =>
  Provider.succeed(ManagementGroup, {
    stables: ["groupName", "managementGroupId", "tenantId"],

    // Management groups carry no tags, and listing them needs read access
    // on the tenant root group, so there is no Alchemy-owned `list`.

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.name !== undefined &&
        news.name.toLowerCase() !== output.groupName.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const { tenantId } = yield* AzureEnvironment.current;
      const generated = yield* generatedName(id, instanceId);
      const name = output?.groupName ?? olds?.name ?? generated;
      const observed = yield* getGroup(name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(name, tenantId, observed);
      // No tags: a group we created is either in state or carries the
      // instance-unique generated name.
      return output !== undefined || name === generated
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const { subscriptionId, tenantId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Management");
      const name =
        news.name ??
        output?.groupName ??
        (yield* generatedName(id, instanceId));
      const parentId = managementGroupIdOf(news.parentId ?? tenantId);
      const displayName = news.displayName ?? name;

      // Observe.
      let observed = yield* getGroupAfterWrite(name);

      // Ensure: the PUT is accepted asynchronously (202); the group is
      // usable once it is readable.
      if (observed === undefined) {
        yield* management.ManagementGroupsCreateOrUpdate({
          groupId: name,
          name,
          properties: { displayName, details: { parent: { id: parentId } } },
        });
        observed = yield* waitForProvisioned(
          `management group ${name}`,
          getGroupAfterWrite(name),
          () => undefined,
          { interval: "15 seconds", times: 60 },
        );
      }

      // Sync display name and parent against the observed group.
      const observedParent = observed.properties?.details?.parent?.id;
      const displayNameChanged =
        observed.properties?.displayName !== displayName;
      const parentChanged =
        observedParent === undefined || !sameId(observedParent, parentId);
      if (displayNameChanged || parentChanged) {
        const updated = yield* management.UpdateManagementGroup({
          groupId: name,
          displayName: displayNameChanged ? displayName : undefined,
          parentGroupId: parentChanged ? parentId : undefined,
        });
        observed = {
          ...observed,
          ...updated,
          properties: { ...observed.properties, ...updated.properties },
        };
      }

      return toAttrs(name, tenantId, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.groupName;
      // DELETE of a missing group answers `AuthorizationFailed`, not 404, so
      // observe first. Without a role on the tenant root, ARM refuses both
      // calls for minutes at a time (the creator's Owner grant propagates
      // slowly and inconsistently across front ends); retry those refusals.
      yield* Effect.gen(function* () {
        if ((yield* getGroup(name)) === undefined) return;
        yield* ignoreNotFound(
          management.DeleteManagementGroup({ groupId: name }),
        );
      }).pipe(
        Effect.retry({
          while: (e) => e._tag === "AuthorizationFailed",
          schedule: Schedule.spaced("10 seconds"),
          times: 60,
        }),
      );
      yield* waitUntilGone(
        `management group ${name}`,
        getGroup(name).pipe(
          Effect.catchTag("AuthorizationFailed", () =>
            Effect.succeed("unauthorized" as const),
          ),
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
