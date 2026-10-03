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

export interface ServiceGroupMemberProps {
  /**
   * ARM ID of the member — a resource, resource group, or subscription —
   * e.g. `account.storageAccountId`. Changing it replaces the membership.
   */
  resourceId: string;
  /**
   * The service group to join: its name or ARM ID
   * (`/providers/Microsoft.Management/serviceGroups/{name}`), e.g.
   * `group.serviceGroupId`. Changing it replaces the membership.
   */
  serviceGroup: string;
  /**
   * Tenant ID of the service group, for cross-tenant membership. Changing
   * it replaces the membership.
   * @default the tenant of the member
   */
  sourceTenant?: string;
  /**
   * Relationship name (3-64 letters, digits, and hyphens). If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the membership.
   */
  name?: string;
}

export interface ServiceGroupMember extends Resource<
  "Azure.Relationships.ServiceGroupMember",
  ServiceGroupMemberProps,
  {
    /** Relationship name. */
    relationshipName: string;
    /**
     * ARM ID of the relationship,
     * `{resourceId}/providers/Microsoft.Relationships/serviceGroupMember/{name}`.
     */
    relationshipId: string;
    /** ARM ID of the member resource. */
    resourceId: string;
    /** ARM ID of the service group. */
    serviceGroupId: string;
    /** Tenant ID of the service group. */
    sourceTenant: string | undefined;
    /** Resource type of the member, e.g. `Microsoft.Storage/storageAccounts`. */
    memberType: string | undefined;
    /** Origin of the relationship, e.g. `UserExplicitlyCreated`. */
    originType: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Membership of an ARM resource, resource group, or subscription in an
 * Azure service group (Microsoft.Relationships `serviceGroupMember`).
 *
 * The membership is an extension resource on the member and is deleted
 * with it. Memberships cannot be tagged; a generated name (derived from
 * the app, stage, and logical ID) identifies Alchemy's own. The tenant
 * must have Azure Service Groups enabled; otherwise Azure rejects the
 * write with `RelationshipCallbacksNotEnabled`.
 *
 * @see https://learn.microsoft.com/azure/governance/service-groups/create-service-group-member-rest-api
 *
 * ### Adding Members
 * **Example:** Add a storage account to a service group
 * ```typescript
 * const checkout = yield* Azure.Management.ServiceGroup("checkout", {
 *   displayName: "Checkout",
 * });
 * yield* Azure.Relationships.ServiceGroupMember("checkout-storage", {
 *   resourceId: account.storageAccountId,
 *   serviceGroup: checkout.serviceGroupId,
 * });
 * ```
 *
 * **Example:** Add a whole resource group
 * ```typescript
 * yield* Azure.Relationships.ServiceGroupMember("checkout-rg", {
 *   resourceId: group.resourceGroupId,
 *   serviceGroup: checkout.serviceGroupId,
 * });
 * ```
 *
 * @resource
 */
export const ServiceGroupMember = Resource<ServiceGroupMember>(
  "Azure.Relationships.ServiceGroupMember",
);

const PREFIX = "/providers/Microsoft.Management/serviceGroups/";

/** Service group ARM ID from a bare name or an ARM ID. */
const serviceGroupIdOf = (nameOrId: string) =>
  nameOrId.includes("/")
    ? `/${nameOrId.replace(/^\/+/, "").replace(/\/+$/, "")}`
    : `${PREFIX}${nameOrId}`;

const generatedName = (id: string) => createPhysicalName({ id, maxLength: 64 });

const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").replace(/^\/+|\/+$/g, "").toLowerCase() ===
  (b ?? "").replace(/^\/+|\/+$/g, "").toLowerCase();

const getMembership = (resourceUri: string, name: string) =>
  orUndefinedIfNotFound(
    relationships.GetServiceGroupMemberRelationship({ resourceUri, name }),
  );

const toAttrs = (
  resourceId: string,
  name: string,
  observed: relationships.GetServiceGroupMemberRelationshipResponse,
): ServiceGroupMember["Attributes"] => ({
  relationshipName: name,
  relationshipId:
    observed.id ??
    `${resourceId}/providers/Microsoft.Relationships/serviceGroupMember/${name}`,
  resourceId: observed.properties?.targetId ?? resourceId,
  serviceGroupId: observed.properties?.sourceId ?? "",
  sourceTenant: observed.properties?.sourceTenant,
  memberType: observed.properties?.metadata?.targetType,
  originType: observed.properties?.originInformation?.relationshipOriginType,
  provisioningState: observed.properties?.provisioningState,
});

export const ServiceGroupMemberProvider = () =>
  Provider.succeed(ServiceGroupMember, {
    stables: [
      "relationshipName",
      "relationshipId",
      "resourceId",
      "serviceGroupId",
    ],

    // No subscription-wide list operation exists (only per member), and
    // memberships are deleted with their member, so `list` keeps the
    // default empty result.

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      if (
        !("resourceId" in news) ||
        !("serviceGroup" in news) ||
        !isResolved(news.resourceId) ||
        !isResolved(news.serviceGroup)
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved<ServiceGroupMemberProps>(news)) return undefined;
      if (
        !sameId(news.resourceId, output.resourceId) ||
        !sameId(serviceGroupIdOf(news.serviceGroup), output.serviceGroupId) ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.relationshipName.toLowerCase()) ||
        (news.sourceTenant !== undefined &&
          news.sourceTenant.toLowerCase() !==
            (output.sourceTenant ?? "").toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const resourceId = output?.resourceId ?? olds?.resourceId;
      if (resourceId === undefined) return undefined;
      const name =
        output?.relationshipName ?? olds?.name ?? (yield* generatedName(id));
      const observed = yield* getMembership(resourceId, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceId, name, observed);
      // No tags or description: only a membership we recorded, or one
      // carrying the generated (stack/stage/id-derived) name, is ours.
      return output !== undefined || olds?.name === undefined
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Relationships");
      const resourceId = news.resourceId;
      const serviceGroupId = serviceGroupIdOf(news.serviceGroup);
      const name =
        news.name ?? output?.relationshipName ?? (yield* generatedName(id));

      // Observe.
      const observed = yield* getMembership(resourceId, name);

      // Ensure: existence-only; PUT (an upsert) when missing or when an
      // adopted one points at a different service group.
      if (
        observed === undefined ||
        !sameId(observed.properties?.sourceId, serviceGroupId) ||
        (news.sourceTenant !== undefined &&
          (observed.properties?.sourceTenant ?? "").toLowerCase() !==
            news.sourceTenant.toLowerCase())
      ) {
        yield* relationships.ServiceGroupMemberRelationshipsCreateOrUpdate({
          resourceUri: resourceId,
          name,
          properties: {
            sourceId: serviceGroupId,
            sourceTenant: news.sourceTenant,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `serviceGroupMember relationship ${name}`,
        getMembership(resourceId, name),
        (value) => value.properties?.provisioningState,
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceId, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        relationships.DeleteServiceGroupMemberRelationship({
          resourceUri: output.resourceId,
          name: output.relationshipName,
        }),
      );
      yield* waitUntilGone(
        `serviceGroupMember relationship ${output.relationshipName}`,
        getMembership(output.resourceId, output.relationshipName),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Management.ServiceGroup",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
