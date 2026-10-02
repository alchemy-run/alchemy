import * as authorization from "@distilled.cloud/azure/authorization";
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

/** One permission block of a custom role. */
export interface RolePermission {
  /**
   * Control-plane operations the role allows, e.g.
   * `Microsoft.Storage/storageAccounts/read`. Wildcards (`*`) are allowed.
   */
  actions?: string[];
  /** Control-plane operations excluded from `actions`. */
  notActions?: string[];
  /**
   * Data-plane operations the role allows, e.g.
   * `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read`.
   */
  dataActions?: string[];
  /** Data-plane operations excluded from `dataActions`. */
  notDataActions?: string[];
}

export interface RoleDefinitionProps {
  /**
   * ARM ID of the scope the role is defined at — a subscription
   * (`/subscriptions/{id}`) or a resource group. It must be one of the
   * `assignableScopes`. Changing it replaces the role.
   * @default the current subscription
   */
  scope?: string;
  /**
   * Display name of the role. Role names are unique across the whole
   * Microsoft Entra directory (tenant), built-in roles included.
   * @default a unique name generated from the app, stage and logical ID
   */
  roleName?: string;
  /**
   * Description shown in the portal. Alchemy appends an ownership marker
   * (`[alchemy <stack>/<stage>/<id>]`) because role definitions have no
   * tags.
   */
  description?: string;
  /** Operations the role grants (and excludes). */
  permissions: RolePermission[];
  /**
   * Scopes the role can be assigned at (subscription or resource-group
   * IDs).
   * @default [scope]
   */
  assignableScopes?: string[];
}

export interface RoleDefinition extends Resource<
  "Azure.Authorization.RoleDefinition",
  RoleDefinitionProps,
  {
    /** Role-definition name (a GUID). */
    roleDefinitionName: string;
    /**
     * Full role-definition ID
     * (`/subscriptions/{id}/providers/Microsoft.Authorization/roleDefinitions/{guid}`),
     * usable as a role assignment's `roleDefinitionId`.
     */
    roleDefinitionId: string;
    /** Scope the role is defined at. */
    scope: string;
    /** Display name of the role. */
    roleName: string;
    /** Scopes the role can be assigned at. */
    assignableScopes: string[];
  },
  never,
  Providers
> {}

/**
 * An Azure RBAC custom role — a named set of control-plane and data-plane
 * permissions that can be granted with a
 * {@link RoleAssignment}.
 *
 * Role definitions cannot be tagged, so Alchemy records ownership as a
 * `[alchemy <stack>/<stage>/<id>]` marker at the end of the description.
 * The role's GUID name is derived from the stack, stage, logical ID and
 * instance ID, so re-running a deploy converges on the same role. Role
 * names are tenant-unique; the default name is generated per stage.
 *
 * @see https://learn.microsoft.com/azure/role-based-access-control/custom-roles
 *
 * ### Defining a Custom Role
 * **Example:** Read-only access to storage accounts in one resource group
 * ```typescript
 * const role = yield* Azure.Authorization.RoleDefinition("StorageReader", {
 *   scope: group.resourceGroupId,
 *   description: "Reads storage account metadata",
 *   permissions: [{ actions: ["Microsoft.Storage/storageAccounts/read"] }],
 * });
 * ```
 *
 * ### Granting a Custom Role
 * **Example:** Assign the custom role to a managed identity
 * ```typescript
 * yield* Azure.Authorization.RoleAssignment("api-reads-storage", {
 *   scope: group.resourceGroupId,
 *   roleDefinitionId: role.roleDefinitionId,
 *   principalId: identity.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * @resource
 */
export const RoleDefinition = Resource<RoleDefinition>(
  "Azure.Authorization.RoleDefinition",
);

const getDefinition = (scope: string, roleDefinitionId: string) =>
  orUndefinedIfNotFound(
    authorization.GetRoleDefinition({ scope, roleDefinitionId }),
  ).pipe(
    Effect.catchTag("RoleDefinitionNotFound", () => Effect.succeed(undefined)),
  );

const sorted = (values: string[] | undefined) =>
  [...(values ?? [])].sort((a, b) => a.localeCompare(b));

const canonicalPermissions = (permissions: RolePermission[] | undefined) =>
  JSON.stringify(
    (permissions ?? []).map((p) => ({
      actions: sorted(p.actions),
      notActions: sorted(p.notActions),
      dataActions: sorted(p.dataActions),
      notDataActions: sorted(p.notDataActions),
    })),
  );

const canonicalScopes = (scopes: string[] | undefined) =>
  sorted((scopes ?? []).map(normalizeScope)).join(",");

const toAttrs = (
  scope: string,
  name: string,
  definition: authorization.RoleDefinition,
): RoleDefinition["Attributes"] => ({
  roleDefinitionName: name,
  roleDefinitionId:
    definition.id ??
    `${scope}/providers/Microsoft.Authorization/roleDefinitions/${name}`,
  scope,
  roleName: definition.properties?.roleName ?? "",
  assignableScopes: definition.properties?.assignableScopes ?? [],
});

const defaultScope = Effect.gen(function* () {
  const { subscriptionId } = yield* AzureEnvironment.current;
  return `/subscriptions/${subscriptionId}`;
});

export const RoleDefinitionProvider = () =>
  Provider.succeed(RoleDefinition, {
    stables: ["roleDefinitionName", "roleDefinitionId", "scope"],

    list: Effect.fn(function* () {
      const scope = yield* defaultScope;
      const page = yield* authorization
        .ListRoleDefinitions({ scope, _filter: "type eq 'CustomRole'" })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListRoleDefinitions", page),
          ),
        );
      return (page.value ?? []).flatMap((definition) =>
        MARKER.test(definition.properties?.description ?? "") &&
        definition.name !== undefined
          ? [
              toAttrs(
                definition.properties?.assignableScopes?.[0] ?? scope,
                definition.name,
                definition,
              ),
            ]
          : [],
      );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // Upstream scope IDs are stable attributes; an unresolved scope means
      // its resource is being replaced.
      if (!isResolved(news.scope)) return { action: "replace" } as const;
      if (!isResolved(news)) return undefined;
      const scope = news.scope ?? (yield* defaultScope);
      if (normalizeScope(scope) !== normalizeScope(output.scope)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const scope =
        output?.scope ??
        (typeof olds?.scope === "string" ? olds.scope : undefined) ??
        (yield* defaultScope);
      const name =
        output?.roleDefinitionName ??
        (yield* deterministicGuid(id, instanceId));
      const observed = yield* getDefinition(scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, name, observed);
      const marker = yield* ownershipMarker(id);
      return (observed.properties?.description ?? "").endsWith(marker)
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Authorization");
      const scope = news.scope ?? `/subscriptions/${subscriptionId}`;
      const name =
        output?.roleDefinitionName ??
        (yield* deterministicGuid(id, instanceId));
      const roleName =
        news.roleName ?? (yield* createPhysicalName({ id, maxLength: 128 }));
      const description = descriptionWithMarker(
        news.description,
        yield* ownershipMarker(id),
      );
      const assignableScopes = news.assignableScopes ?? [scope];

      // Observe.
      const observed = (yield* getDefinition(scope, name))?.properties;

      // Ensure + sync. The PUT is a full-body upsert (there is no PATCH);
      // skip it when every mutable aspect already matches.
      if (
        observed === undefined ||
        observed.roleName !== roleName ||
        observed.description !== description ||
        canonicalPermissions(observed.permissions) !==
          canonicalPermissions(news.permissions) ||
        canonicalScopes(observed.assignableScopes) !==
          canonicalScopes(assignableScopes)
      ) {
        yield* authorization.RoleDefinitionsCreateOrUpdate({
          scope,
          roleDefinitionId: name,
          properties: {
            roleName,
            description,
            type: "CustomRole",
            permissions: news.permissions,
            assignableScopes,
          },
        });
      }

      // Custom-role reads are eventually consistent across ARM replicas;
      // wait until the definition is readable with the desired name.
      const fresh = yield* waitForProvisioned(
        `role definition ${name}`,
        getDefinition(scope, name).pipe(
          Effect.map((definition) =>
            definition?.properties?.roleName === roleName &&
            definition.properties.description === description
              ? definition
              : undefined,
          ),
        ),
        () => undefined,
        { interval: "2 seconds", times: 30 },
      );
      return toAttrs(scope, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        authorization.DeleteRoleDefinition({
          scope: output.scope,
          roleDefinitionId: output.roleDefinitionName,
        }),
      ).pipe(
        Effect.catchTag("RoleDefinitionNotFound", () => Effect.void),
        // Deleted role assignments take a moment to stop counting.
        Effect.retry({
          while: (e) => e._tag === "RoleDefinitionHasAssignments",
          schedule: Schedule.spaced("5 seconds"),
          times: 12,
        }),
      );
      yield* waitUntilGone(
        `role definition ${output.roleDefinitionName}`,
        getDefinition(output.scope, output.roleDefinitionName),
        { interval: "2 seconds", times: 30 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
