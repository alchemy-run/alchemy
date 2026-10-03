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

export interface DependencyOfProps {
  /**
   * ARM ID of the dependent (source) resource the relationship is attached
   * to — any resource, resource group, or subscription, e.g.
   * `app.identityId`. Changing it replaces the relationship.
   */
  resourceId: string;
  /**
   * ARM ID of the resource the source depends on, e.g.
   * `database.serverId`. Changing it replaces the relationship.
   */
  targetId: string;
  /**
   * Tenant ID of the target resource, for cross-tenant dependencies.
   * Changing it replaces the relationship.
   * @default the tenant of the source resource
   */
  targetTenant?: string;
  /**
   * Relationship name (3-64 letters, digits, and hyphens). If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the relationship.
   */
  name?: string;
}

export interface DependencyOf extends Resource<
  "Azure.Relationships.DependencyOf",
  DependencyOfProps,
  {
    /** Relationship name. */
    relationshipName: string;
    /**
     * ARM ID of the relationship,
     * `{resourceId}/providers/Microsoft.Relationships/dependencyOf/{name}`.
     */
    relationshipId: string;
    /** ARM ID of the dependent (source) resource. */
    sourceId: string;
    /** ARM ID of the resource depended on. */
    targetId: string;
    /** Tenant ID of the target resource. */
    targetTenant: string | undefined;
    /** Resource type of the source, e.g. `Microsoft.Web/sites`. */
    sourceType: string | undefined;
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
 * An Azure `dependencyOf` relationship (Microsoft.Relationships) — records
 * that one ARM resource depends on another, so Azure Service Groups and
 * health models can trace the impact of an outage across a workload.
 *
 * The relationship is an extension resource on the dependent resource and
 * is deleted with it. Relationships cannot be tagged; a generated name
 * (derived from the app, stage, and logical ID) identifies Alchemy's own.
 *
 * @see https://learn.microsoft.com/azure/templates/microsoft.relationships/dependencyof
 *
 * ### Recording a Dependency
 * **Example:** A web app depends on its database server
 * ```typescript
 * yield* Azure.Relationships.DependencyOf("app-needs-db", {
 *   resourceId: app.siteId,
 *   targetId: server.serverId,
 * });
 * ```
 *
 * ### Naming the Relationship
 * **Example:** Explicit relationship name
 * ```typescript
 * yield* Azure.Relationships.DependencyOf("api-needs-identity", {
 *   resourceId: api.identityId,
 *   targetId: vault.vaultId,
 *   name: "api-vault",
 * });
 * ```
 *
 * @resource
 */
export const DependencyOf = Resource<DependencyOf>(
  "Azure.Relationships.DependencyOf",
);

const generatedName = (id: string) => createPhysicalName({ id, maxLength: 64 });

const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").replace(/\/+$/, "").toLowerCase() ===
  (b ?? "").replace(/\/+$/, "").toLowerCase();

const getRelationship = (resourceUri: string, name: string) =>
  orUndefinedIfNotFound(
    relationships.GetDependencyOfRelationship({ resourceUri, name }),
  );

const toAttrs = (
  resourceId: string,
  name: string,
  observed: relationships.GetDependencyOfRelationshipResponse,
): DependencyOf["Attributes"] => ({
  relationshipName: name,
  relationshipId:
    observed.id ??
    `${resourceId}/providers/Microsoft.Relationships/dependencyOf/${name}`,
  sourceId: observed.properties?.sourceId ?? resourceId,
  targetId: observed.properties?.targetId ?? "",
  targetTenant: observed.properties?.targetTenant,
  sourceType: observed.properties?.metadata?.sourceType,
  targetType: observed.properties?.metadata?.targetType,
  originType: observed.properties?.originInformation?.relationshipOriginType,
  provisioningState: observed.properties?.provisioningState,
});

export const DependencyOfProvider = () =>
  Provider.succeed(DependencyOf, {
    stables: ["relationshipName", "relationshipId", "sourceId", "targetId"],

    // No subscription-wide list operation exists (only per source
    // resource), and relationships are deleted with their source resource,
    // so `list` keeps the default empty result.

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // Source and target are identity; an unresolved one means its
      // resource is being replaced.
      if (
        !("resourceId" in news) ||
        !("targetId" in news) ||
        !isResolved(news.resourceId) ||
        !isResolved(news.targetId)
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved<DependencyOfProps>(news)) return undefined;
      if (
        !sameId(news.resourceId, output.sourceId) ||
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
      const resourceId = output?.sourceId ?? olds?.resourceId;
      if (resourceId === undefined) return undefined;
      const name =
        output?.relationshipName ?? olds?.name ?? (yield* generatedName(id));
      const observed = yield* getRelationship(resourceId, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceId, name, observed);
      // No tags or description: only a relationship we recorded, or one
      // carrying the generated (stack/stage/id-derived) name, is ours.
      return output !== undefined || olds?.name === undefined
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Relationships");
      const resourceId = news.resourceId;
      const name =
        news.name ?? output?.relationshipName ?? (yield* generatedName(id));

      // Observe.
      const observed = yield* getRelationship(resourceId, name);

      // Ensure: the relationship is existence-only; PUT (an upsert) when
      // missing or when an adopted one points at a different target.
      if (
        observed === undefined ||
        !sameId(observed.properties?.targetId, news.targetId) ||
        (news.targetTenant !== undefined &&
          (observed.properties?.targetTenant ?? "").toLowerCase() !==
            news.targetTenant.toLowerCase())
      ) {
        yield* relationships.DependencyOfRelationshipsCreateOrUpdate({
          resourceUri: resourceId,
          name,
          properties: {
            targetId: news.targetId,
            targetTenant: news.targetTenant,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `dependencyOf relationship ${name}`,
        getRelationship(resourceId, name),
        (value) => value.properties?.provisioningState,
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceId, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        relationships.DeleteDependencyOfRelationship({
          resourceUri: output.sourceId,
          name: output.relationshipName,
        }),
      );
      yield* waitUntilGone(
        `dependencyOf relationship ${output.relationshipName}`,
        getRelationship(output.sourceId, output.relationshipName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
