import * as relationships from "@distilled.cloud/azure/relationships";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface ServiceGroupDependencyOfProps {
  /**
   * The dependent service group: its name or ARM ID
   * (`/providers/Microsoft.Management/serviceGroups/{name}`), e.g.
   * `group.serviceGroupName`. Changing it replaces the relationship.
   */
  serviceGroup: string;
  /**
   * ARM ID of the resource (or service group) the service group depends
   * on. Changing it replaces the relationship.
   */
  targetId: string;
  /**
   * Tenant ID of the target, for cross-tenant dependencies. Changing it
   * replaces the relationship.
   * @default the tenant of the service group
   */
  targetTenant?: string;
  /**
   * Relationship name (3-64 letters, digits, and hyphens). If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the relationship.
   */
  name?: string;
}

export interface ServiceGroupDependencyOf extends Resource<
  "Azure.Relationships.ServiceGroupDependencyOf",
  ServiceGroupDependencyOfProps,
  {
    /** Relationship name. */
    relationshipName: string;
    /** ARM ID of the relationship. */
    relationshipId: string;
    /** Name of the dependent service group. */
    serviceGroupName: string;
    /** ARM ID of the dependent service group. */
    sourceId: string;
    /** ARM ID of the target depended on. */
    targetId: string;
    /** Tenant ID of the target. */
    targetTenant: string | undefined;
    /** Resource type of the target, e.g. `Microsoft.Sql/servers`. */
    targetType: string | undefined;
    /** Origin of the relationship, e.g. `UserExplicitlyCreated`. */
    originType: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure `dependencyOf` relationship on a service group
 * (Microsoft.Relationships) — records that a whole service group (a
 * workload) depends on another resource or service group, so health and
 * impact views can follow the dependency.
 *
 * The relationship is an extension resource on the tenant-level service
 * group and is deleted with it. Relationships cannot be tagged; a
 * generated name (derived from the app, stage, and logical ID) identifies
 * Alchemy's own.
 *
 * @see https://learn.microsoft.com/azure/governance/service-groups/overview
 *
 * ### Recording a Workload Dependency
 * **Example:** A service group depends on a shared database server
 * ```typescript
 * const checkout = yield* Azure.Management.ServiceGroup("checkout", {
 *   displayName: "Checkout",
 * });
 * yield* Azure.Relationships.ServiceGroupDependencyOf("checkout-needs-db", {
 *   serviceGroup: checkout.serviceGroupName,
 *   targetId: server.serverId,
 * });
 * ```
 *
 * ### Depending on Another Service Group
 * **Example:** Checkout depends on the payments service group
 * ```typescript
 * yield* Azure.Relationships.ServiceGroupDependencyOf("checkout-needs-payments", {
 *   serviceGroup: checkout.serviceGroupName,
 *   targetId: payments.serviceGroupId,
 * });
 * ```
 *
 * @resource
 */
export const ServiceGroupDependencyOf = Resource<ServiceGroupDependencyOf>(
  "Azure.Relationships.ServiceGroupDependencyOf",
);

const PREFIX = "/providers/Microsoft.Management/serviceGroups/";

/** Service group name from a bare name or an ARM ID. */
const serviceGroupNameOf = (nameOrId: string) =>
  nameOrId.replace(/\/+$/, "").split("/").pop() ?? nameOrId;

const generatedName = (id: string) => createPhysicalName({ id, maxLength: 64 });

const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").replace(/\/+$/, "").toLowerCase() ===
  (b ?? "").replace(/\/+$/, "").toLowerCase();

const getRelationship = (serviceGroupName: string, name: string) =>
  orUndefinedIfNotFound(
    relationships.GetDependencyOfRelationshipsByServiceGroup({
      serviceGroupName,
      name,
    }),
  );

const toAttrs = (
  serviceGroupName: string,
  name: string,
  observed: relationships.GetDependencyOfRelationshipsByServiceGroupResponse,
): ServiceGroupDependencyOf["Attributes"] => ({
  relationshipName: name,
  relationshipId:
    observed.id ??
    `${PREFIX}${serviceGroupName}/providers/Microsoft.Relationships/dependencyOf/${name}`,
  serviceGroupName,
  sourceId: observed.properties?.sourceId ?? `${PREFIX}${serviceGroupName}`,
  targetId: observed.properties?.targetId ?? "",
  targetTenant: observed.properties?.targetTenant,
  targetType: observed.properties?.metadata?.targetType,
  originType: observed.properties?.originInformation?.relationshipOriginType,
  provisioningState: observed.properties?.provisioningState,
});

export const ServiceGroupDependencyOfProvider = () =>
  Provider.succeed(ServiceGroupDependencyOf, {
    stables: [
      "relationshipName",
      "relationshipId",
      "serviceGroupName",
      "sourceId",
      "targetId",
    ],

    // No tenant-wide list operation exists, and relationships are deleted
    // with their service group, so `list` keeps the default empty result.

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      if (
        !("serviceGroup" in news) ||
        !("targetId" in news) ||
        !isResolved(news.serviceGroup) ||
        !isResolved(news.targetId)
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved<ServiceGroupDependencyOfProps>(news)) return undefined;
      if (
        serviceGroupNameOf(news.serviceGroup).toLowerCase() !==
          output.serviceGroupName.toLowerCase() ||
        !sameId(news.targetId, output.targetId) ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.relationshipName.toLowerCase()) ||
        (news.targetTenant !== undefined &&
          news.targetTenant.toLowerCase() !==
            (output.targetTenant ?? "").toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const group =
        output?.serviceGroupName ??
        (olds?.serviceGroup !== undefined
          ? serviceGroupNameOf(olds.serviceGroup)
          : undefined);
      if (group === undefined) return undefined;
      const name =
        output?.relationshipName ?? olds?.name ?? (yield* generatedName(id));
      const observed = yield* getRelationship(group, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(group, name, observed);
      // No tags or description: only a relationship we recorded, or one
      // carrying the generated (stack/stage/id-derived) name, is ours.
      return output !== undefined || olds?.name === undefined
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Relationships");
      const group = serviceGroupNameOf(news.serviceGroup);
      const name =
        news.name ?? output?.relationshipName ?? (yield* generatedName(id));

      // Observe.
      const observed = yield* getRelationship(group, name);

      // Ensure: existence-only; PUT (an upsert) when missing or when an
      // adopted one points at a different target.
      if (
        observed === undefined ||
        !sameId(observed.properties?.targetId, news.targetId) ||
        (news.targetTenant !== undefined &&
          (observed.properties?.targetTenant ?? "").toLowerCase() !==
            news.targetTenant.toLowerCase())
      ) {
        yield* relationships.DependencyOfRelationshipsByServiceGroupCreateOrUpdate(
          {
            serviceGroupName: group,
            name,
            properties: {
              targetId: news.targetId,
              targetTenant: news.targetTenant,
            },
          },
        );
      }

      const fresh = yield* waitForProvisioned(
        `service group dependencyOf relationship ${name}`,
        getRelationship(group, name),
        (value) => value.properties?.provisioningState,
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(group, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        relationships.DeleteDependencyOfRelationshipsByServiceGroup({
          serviceGroupName: output.serviceGroupName,
          name: output.relationshipName,
        }),
      );
      yield* waitUntilGone(
        `service group dependencyOf relationship ${output.relationshipName}`,
        getRelationship(output.serviceGroupName, output.relationshipName),
      );
    }),

    nuke: { dependsOn: ["Azure.Management.ServiceGroup"] },
  });
