import * as authorization from "@distilled.cloud/azure/authorization";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  descriptionWithMarker,
  deterministicGuid,
  MARKER,
  normalizeScope,
  ownershipMarker,
} from "./Ownership.ts";

export type PrincipalType = authorization.RoleAssignmentPropertiesPrincipalType;

export interface RoleAssignmentProps {
  /**
   * ARM ID of the scope the role is granted on — a subscription
   * (`/subscriptions/{id}`), a resource group, or a single resource such as
   * `account.storageAccountId`. Grant at the narrowest scope that works.
   * Changing it replaces the assignment.
   */
  scope: string;
  /**
   * Role to grant: a full role-definition ID
   * (`/subscriptions/{id}/providers/Microsoft.Authorization/roleDefinitions/{guid}`)
   * or just the role GUID, e.g. a {@link BuiltInRole} value. Changing it
   * replaces the assignment.
   */
  roleDefinitionId: string;
  /**
   * Object ID of the user, group, or service principal receiving the role,
   * e.g. `identity.principalId`. Changing it replaces the assignment.
   */
  principalId: string;
  /**
   * Kind of principal. Set `ServicePrincipal` for managed identities: it
   * lets Azure skip the directory lookup that fails while a new identity is
   * still replicating. Changing it replaces the assignment.
   */
  principalType?: PrincipalType;
  /**
   * Description shown in the portal. Alchemy appends an ownership marker
   * (`[alchemy <stack>/<stage>/<id>]`) because role assignments have no
   * tags.
   */
  description?: string;
  /**
   * ABAC condition that narrows the grant, e.g. to one blob container. See
   * https://learn.microsoft.com/azure/role-based-access-control/conditions-overview
   */
  condition?: string;
}

export interface RoleAssignment extends Resource<
  "Azure.Authorization.RoleAssignment",
  RoleAssignmentProps,
  {
    /** Role-assignment name (a GUID). */
    roleAssignmentName: string;
    /** ARM ID of the role assignment. */
    roleAssignmentId: string;
    /** Scope the role is granted on. */
    scope: string;
    /** Full role-definition ID. */
    roleDefinitionId: string;
    /** Principal holding the role. */
    principalId: string;
    /** Kind of principal, when known. */
    principalType: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Well-known Azure built-in role GUIDs. Pass one as
 * {@link RoleAssignmentProps.roleDefinitionId}.
 *
 * @see https://learn.microsoft.com/azure/role-based-access-control/built-in-roles
 */
export const BuiltInRole = {
  Owner: "8e3af657-a8ff-443c-a75c-2fe8c4bcb635",
  Contributor: "b24988ac-6180-42a0-ab88-20f7382dd24c",
  Reader: "acdd72a7-3385-48ef-bd42-f606fba81ae7",
  StorageBlobDataReader: "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1",
  StorageBlobDataContributor: "ba92f5b4-2d11-453d-a403-e96b0029c9fe",
  StorageBlobDataOwner: "b7e6dc6d-f1e8-4753-8033-0f276bb0955b",
  StorageQueueDataReader: "19e7f393-937e-4f77-808e-94535e297925",
  StorageQueueDataContributor: "974c5e8b-45b9-4653-ba55-5f855dd0fb88",
  KeyVaultSecretsUser: "4633458b-17de-408a-b874-0445c86b69e6",
} as const;

/**
 * An Azure RBAC role assignment — grants a role to a principal (a managed
 * identity, service principal, user, or group) at a scope.
 *
 * Role assignments cannot be tagged, so Alchemy records ownership as a
 * `[alchemy <stack>/<stage>/<id>]` marker at the end of the description.
 * The assignment name is a GUID derived from the stack, stage, logical ID,
 * and instance ID, so re-running a deploy converges on the same assignment.
 *
 * @see https://learn.microsoft.com/azure/role-based-access-control/role-assignments
 *
 * ### Granting a Role
 * **Example:** Let a managed identity read blobs in one storage account
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("api", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Authorization.RoleAssignment("api-reads-files", {
 *   scope: account.storageAccountId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataReader,
 *   principalId: identity.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * ### Conditional Access
 * **Example:** Restrict a grant to one blob container
 * ```typescript
 * yield* Azure.Authorization.RoleAssignment("api-writes-uploads", {
 *   scope: account.storageAccountId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataContributor,
 *   principalId: identity.principalId,
 *   principalType: "ServicePrincipal",
 *   condition:
 *     "@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringEquals 'uploads'",
 * });
 * ```
 *
 * @resource
 */
export const RoleAssignment = Resource<RoleAssignment>(
  "Azure.Authorization.RoleAssignment",
);

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Expand a bare role GUID to a subscription-scoped role-definition ID. */
export const roleDefinitionIdOf = (
  subscriptionId: string,
  role: string,
): string =>
  GUID.test(role)
    ? `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${role}`
    : role;

const roleGuidOf = (roleDefinitionId: string) =>
  roleDefinitionId.split("/").pop()?.toLowerCase() ?? roleDefinitionId;

/** Deterministic GUID name for the assignment. */
const assignmentName = deterministicGuid;

const getAssignment = (scope: string, roleAssignmentName: string) =>
  orUndefinedIfNotFound(
    authorization.GetRoleAssignment({ scope, roleAssignmentName }),
  );

const toAttrs = (
  scope: string,
  name: string,
  assignment: authorization.GetRoleAssignmentResponse,
): RoleAssignment["Attributes"] => ({
  roleAssignmentName: name,
  roleAssignmentId:
    assignment.id ??
    `${scope}/providers/Microsoft.Authorization/roleAssignments/${name}`,
  scope: assignment.properties?.scope ?? scope,
  roleDefinitionId: assignment.properties?.roleDefinitionId ?? "",
  principalId: assignment.properties?.principalId ?? "",
  principalType: assignment.properties?.principalType,
});

export const RoleAssignmentProvider = () =>
  Provider.succeed(RoleAssignment, {
    stables: [
      "roleAssignmentName",
      "roleAssignmentId",
      "scope",
      "roleDefinitionId",
      "principalId",
      "principalType",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* authorization
        .ListRoleAssignmentForSubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListRoleAssignmentForSubscription", page),
          ),
        );
      return page.value.flatMap((assignment) =>
        MARKER.test(assignment.properties?.description ?? "") &&
        assignment.name !== undefined &&
        assignment.properties?.scope !== undefined
          ? [toAttrs(assignment.properties.scope, assignment.name, assignment)]
          : [],
      );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // Scope, role and principal IDs are stable attributes upstream; an
      // unresolved one means its resource is being replaced.
      if (
        !isResolved(news.scope) ||
        !isResolved(news.roleDefinitionId) ||
        !isResolved(news.principalId)
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (
        normalizeScope(news.scope) !== normalizeScope(output.scope) ||
        roleGuidOf(news.roleDefinitionId) !==
          roleGuidOf(output.roleDefinitionId) ||
        news.principalId.toLowerCase() !== output.principalId.toLowerCase() ||
        (news.principalType !== undefined &&
          news.principalType !== output.principalType)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const scope = output?.scope ?? olds?.scope;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its scope.
      if (scope === undefined) return undefined;
      const name =
        output?.roleAssignmentName ?? (yield* assignmentName(id, instanceId));
      const observed = yield* getAssignment(scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, name, observed);
      const marker = yield* ownershipMarker(id);
      return (observed.properties?.description ?? "").endsWith(marker)
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const scope = news.scope;
      const name =
        output?.roleAssignmentName ?? (yield* assignmentName(id, instanceId));
      const roleDefinitionId = roleDefinitionIdOf(
        subscriptionId,
        news.roleDefinitionId,
      );
      const description = descriptionWithMarker(
        news.description,
        yield* ownershipMarker(id),
      );

      // Observe.
      const observed = yield* getAssignment(scope, name);

      // Ensure + sync. Only the description and condition are mutable; the
      // PUT is an upsert, so skip it when both already match.
      const current = observed?.properties;
      if (
        current === undefined ||
        current.description !== description ||
        (current.condition ?? undefined) !== news.condition
      ) {
        yield* authorization
          .CreateRoleAssignment({
            scope,
            roleAssignmentName: name,
            properties: {
              roleDefinitionId,
              principalId: news.principalId,
              principalType: news.principalType,
              description,
              condition: news.condition,
              conditionVersion: news.condition ? "2.0" : undefined,
            },
          })
          .pipe(
            // A freshly created identity takes a moment to replicate
            // through Microsoft Entra ID.
            Effect.retry({
              while: (e) => e._tag === "PrincipalNotFound",
              schedule: Schedule.spaced("5 seconds"),
              times: 12,
            }),
          );
      }

      // Role assignments have no provisioning state; wait until readable.
      const fresh = yield* waitForProvisioned(
        `role assignment ${name}`,
        getAssignment(scope, name),
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(scope, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        authorization.DeleteRoleAssignment({
          scope: output.scope,
          roleAssignmentName: output.roleAssignmentName,
        }),
      );
      yield* waitUntilGone(
        `role assignment ${output.roleAssignmentName}`,
        getAssignment(output.scope, output.roleAssignmentName),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Authorization.RoleDefinition",
        "Azure.ManagedIdentity.UserAssignedIdentity",
        "Azure.Storage.*",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
