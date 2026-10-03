import * as management from "@distilled.cloud/azure/management";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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

export interface ServiceGroupProps {
  /**
   * Service group name, unique in the tenant: letters, digits, `-`, `_`,
   * `.`, `(`, `)` and `~`. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the group.
   */
  name?: string;
  /**
   * Friendly name shown in the portal.
   * @default the group name
   */
  displayName?: string;
  /**
   * Parent service group: its ARM ID
   * (`/providers/Microsoft.Management/serviceGroups/{name}`) or bare name,
   * e.g. `parent.serviceGroupId`. Changing it moves the group in place.
   * @default the tenant root service group
   */
  parentId?: string;
  /**
   * Criticality designation of the group, `0` through `4`.
   */
  criticality?: number;
  /**
   * Kind of the service group. Changing it replaces the group.
   */
  kind?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ServiceGroup extends Resource<
  "Azure.Management.ServiceGroup",
  ServiceGroupProps,
  {
    /** Service group name. */
    serviceGroupName: string;
    /**
     * ARM ID of the service group,
     * `/providers/Microsoft.Management/serviceGroups/{name}`.
     */
    serviceGroupId: string;
    /** Friendly name of the group. */
    displayName: string;
    /** ARM ID of the parent service group. */
    parentId: string;
    /** Criticality designation, when set. */
    criticality: number | undefined;
    /** Kind of the service group, when set. */
    kind: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure service group (preview) — a tenant-level grouping of resources,
 * resource groups, and subscriptions that cuts across the management-group
 * hierarchy, used to aggregate health, cost, and inventory views for a
 * workload.
 *
 * Service groups live outside subscriptions; the deploying identity needs
 * `Microsoft.Management/serviceGroups/write` on the parent group (by
 * default any principal may create groups under the tenant root).
 *
 * @see https://learn.microsoft.com/azure/governance/service-groups/overview
 *
 * ### Creating a Service Group
 * **Example:** Service group under the tenant root
 * ```typescript
 * const checkout = yield* Azure.Management.ServiceGroup("checkout", {
 *   displayName: "Checkout",
 *   criticality: 1,
 *   tags: { team: "payments" },
 * });
 * ```
 *
 * ### Building a Hierarchy
 * **Example:** Nested service groups
 * ```typescript
 * const commerce = yield* Azure.Management.ServiceGroup("commerce", {
 *   displayName: "Commerce",
 * });
 * const checkout = yield* Azure.Management.ServiceGroup("checkout", {
 *   displayName: "Checkout",
 *   parentId: commerce.serviceGroupId,
 * });
 * ```
 *
 * @resource
 */
export const ServiceGroup = Resource<ServiceGroup>(
  "Azure.Management.ServiceGroup",
);

const PREFIX = "/providers/Microsoft.Management/serviceGroups/";

const serviceGroupIdOf = (nameOrId: string) =>
  nameOrId.startsWith("/") ? nameOrId : `${PREFIX}${nameOrId}`;

const sameId = (a: string, b: string) =>
  serviceGroupIdOf(a).replace(/\/+$/, "").toLowerCase() ===
  serviceGroupIdOf(b).replace(/\/+$/, "").toLowerCase();

type ObservedGroup = management.GetServiceGroupResponse;

const getGroup = (serviceGroupName: string) =>
  orUndefinedIfNotFound(
    management
      .GetServiceGroup({ serviceGroupName })
      .pipe(
        Effect.catchTag("ServiceGroupNameNotFound", () =>
          Effect.succeed(undefined),
        ),
      ),
  );

/**
 * Read a group the caller just wrote. The creator's implicit Owner grant on
 * a new group takes a few seconds to propagate, during which reads fail
 * with `AuthorizationFailed`; report those as "not yet visible".
 */
const getGroupAfterWrite = (serviceGroupName: string) =>
  getGroup(serviceGroupName).pipe(
    Effect.catchTag("AuthorizationFailed", () => Effect.succeed(undefined)),
  );

const generatedName = (id: string) => createPhysicalName({ id, maxLength: 90 });

const toAttrs = (
  name: string,
  tenantId: string,
  group: ObservedGroup,
): ServiceGroup["Attributes"] => ({
  serviceGroupName: name,
  serviceGroupId: group.id ?? `${PREFIX}${name}`,
  displayName: group.properties?.displayName ?? name,
  parentId: group.properties?.parent?.resourceId ?? `${PREFIX}${tenantId}`,
  criticality: group.properties?.attributes?.criticality,
  kind: group.kind,
  provisioningState: group.properties?.provisioningState,
  tags: userTags(group.tags),
});

export const ServiceGroupProvider = () =>
  Provider.succeed(ServiceGroup, {
    stables: ["serviceGroupName", "serviceGroupId"],

    // The service-groups API has no list operation, so there is no
    // Alchemy-owned `list`.

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.serviceGroupName.toLowerCase()) ||
        (news.kind ?? undefined) !== (output.kind ?? undefined)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { tenantId } = yield* AzureEnvironment.current;
      const name =
        output?.serviceGroupName ?? olds?.name ?? (yield* generatedName(id));
      const observed = yield* getGroup(name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(name, tenantId, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId, tenantId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Management");
      const name =
        news.name ?? output?.serviceGroupName ?? (yield* generatedName(id));
      const parentId = serviceGroupIdOf(news.parentId ?? tenantId);
      const displayName = news.displayName ?? name;
      const tags = yield* desiredTags(id, news.tags);
      const deltas = (group: ObservedGroup) => ({
        displayName: group.properties?.displayName !== displayName,
        parent:
          group.properties?.parent?.resourceId === undefined ||
          !sameId(group.properties.parent.resourceId, parentId),
        criticality:
          news.criticality !== undefined &&
          group.properties?.attributes?.criticality !== news.criticality,
        tags: tagsDiffer(group.tags, tags),
      });
      // PUT/PATCH are long-running: reads keep returning the previous
      // values (with `Succeeded`) until the operation lands, so after a
      // PATCH also wait for the written values to show up.
      const ready = (requireConverged: boolean) =>
        waitForProvisioned(
          `service group ${name}`,
          getGroupAfterWrite(name),
          (group) => {
            const state = group.properties?.provisioningState;
            if (state !== undefined && state !== "Succeeded") return state;
            return requireConverged &&
              Object.values(deltas(group)).some(Boolean)
              ? "Converging"
              : "Succeeded";
          },
          { interval: "5 seconds", times: 48 },
        );

      // Observe.
      let observed = yield* getGroupAfterWrite(name);

      // Ensure.
      if (observed === undefined) {
        yield* management.CreateOrUpdateServiceGroup({
          serviceGroupName: name,
          kind: news.kind,
          tags,
          properties: {
            displayName,
            parent: { resourceId: parentId },
            attributes:
              news.criticality !== undefined
                ? { criticality: news.criticality }
                : undefined,
          },
        });
      }
      observed = yield* ready(false);

      // Sync display name, parent, criticality and tags against the
      // observed group; PATCH only the deltas.
      const delta = deltas(observed);
      if (
        delta.displayName ||
        delta.parent ||
        delta.criticality ||
        delta.tags
      ) {
        const properties =
          delta.displayName || delta.parent || delta.criticality;
        yield* management.UpdateServiceGroup({
          serviceGroupName: name,
          tags: delta.tags ? tags : undefined,
          properties: properties
            ? {
                displayName: delta.displayName ? displayName : undefined,
                parent: delta.parent ? { resourceId: parentId } : undefined,
                attributes: delta.criticality
                  ? { criticality: news.criticality }
                  : undefined,
              }
            : undefined,
        });
        observed = yield* ready(true);
      }

      return toAttrs(name, tenantId, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.serviceGroupName;
      const deleteGroup = management
        .DeleteServiceGroup({ serviceGroupName: name })
        .pipe(
          Effect.as("deleting" as const),
          Effect.catchTag("ServiceGroupNameNotFound", () =>
            Effect.succeed(undefined),
          ),
        );
      yield* ignoreNotFound(deleteGroup);
      // Once deleted, reads answer 404 briefly and then `AuthorizationFailed`
      // (the group's role assignments are gone with it). A refused read is
      // settled by re-issuing the DELETE, which answers
      // `ServiceGroupNameNotFound` for a deleted group.
      yield* waitUntilGone(
        `service group ${name}`,
        getGroup(name).pipe(
          Effect.catchTag("AuthorizationFailed", () =>
            orUndefinedIfNotFound(deleteGroup),
          ),
        ),
        { interval: "5 seconds", times: 48 },
      );
    }),
  });
