import * as admin from "@distilled.cloud/azure/keyvault-administration";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { deterministicGuid } from "../Authorization/Ownership.ts";
import type { Providers } from "../Providers.ts";
import { lower } from "./common.ts";
import { managedHsmUri } from "./ManagedHsmRoleDefinition.ts";

/**
 * Built-in Managed HSM local RBAC roles (role-definition GUIDs).
 *
 * @see https://learn.microsoft.com/azure/key-vault/managed-hsm/built-in-roles
 */
export const ManagedHsmBuiltInRole = {
  /** Security domain, full backup and restore, and role management. No key operations. */
  Administrator: "a290e904-7015-4bba-90c8-60543313cdb4",
  /** Role management, purge or recover deleted keys, export keys. */
  CryptoOfficer: "515eb02d-2335-4d2d-92f2-b1cbdf9c3778",
  /** Every key operation except purge, recover and export. */
  CryptoUser: "21dbd100-6940-42c2-9190-5d6cb909625b",
  /** Create and delete role assignments. */
  PolicyAdministrator: "4bd23610-cdcf-4971-bdee-bdc562cc28e4",
  /** Read key attributes (not key material). */
  CryptoAuditor: "2c18b078-7c48-4d3a-af88-5a3a1b3f82b3",
  /** Use a key for service encryption. */
  CryptoServiceEncryptionUser: "33413926-3206-4cdd-b39a-83574fe37a17",
  /** Release a key to a trusted execution environment. */
  CryptoServiceReleaseUser: "21dbd100-6940-42c2-9190-5d6cb909625c",
  /** Single-key or whole-HSM backup. */
  Backup: "7b127d3c-77bd-4e3e-bbe0-dbb8971fa7f8",
  /** Single-key or whole-HSM restore. */
  Restore: "6efe6056-5259-49d2-8b3d-d3d73544b20b",
} as const;

const ROLE_DEFINITION_PREFIX =
  "Microsoft.KeyVault/providers/Microsoft.Authorization/roleDefinitions/";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Expand a bare role GUID to a Managed HSM role-definition ID. */
export const managedHsmRoleDefinitionIdOf = (role: string) =>
  GUID.test(role) ? `${ROLE_DEFINITION_PREFIX}${role}` : role;

const roleGuidOf = (roleDefinitionId: string) =>
  roleDefinitionId.split("/").pop()?.toLowerCase() ?? roleDefinitionId;

/** `/`, `/keys`, `/keys/{name}`: compare without case or a trailing slash. */
const normalizeHsmScope = (scope: string) => `/${scope.replace(/^\/+|\/+$/g, "")}`.toLowerCase();

export interface ManagedHsmRoleAssignmentProps {
  /** Name of the managed HSM. Changing it replaces the assignment. */
  managedHsm: string;
  /**
   * Scope inside the HSM: `/` (the whole HSM), `/keys` (every key), or
   * `/keys/{keyName}` (one key). Changing it replaces the assignment.
   * @default "/"
   */
  scope?: string;
  /**
   * A built-in role GUID ({@link ManagedHsmBuiltInRole}) or a
   * {@link ManagedHsmRoleDefinition}'s `roleDefinitionId`. Changing it
   * replaces the assignment.
   */
  roleDefinitionId: string;
  /**
   * Object ID of the user, group, service principal or managed identity
   * that receives the role. Changing it replaces the assignment.
   */
  principalId: string;
}

export interface ManagedHsmRoleAssignment extends Resource<
  "Azure.KeyVault.ManagedHsmRoleAssignment",
  ManagedHsmRoleAssignmentProps,
  {
    /** Name of the managed HSM. */
    managedHsm: string;
    /** Role-assignment name (a GUID). */
    roleAssignmentName: string;
    /** Role-assignment ID inside the HSM. */
    roleAssignmentId: string;
    /** Scope inside the HSM. */
    scope: string;
    /** Role-definition ID that is assigned. */
    roleDefinitionId: string;
    /** Object ID of the principal that has the role. */
    principalId: string;
  },
  never,
  Providers
> {}

/**
 * A role assignment in a Managed HSM's local RBAC: grants a principal an
 * HSM role on the whole HSM, on all keys, or on one key.
 *
 * Managed HSM data-plane access is controlled by the HSM's own (local)
 * RBAC, not by Azure RBAC; an `Azure.Authorization.RoleAssignment` on the
 * HSM resource only grants control-plane access. The HSM must be activated
 * (its security domain downloaded) first. HSM role assignments have no
 * description or tags; the GUID name is derived from the stack, stage,
 * logical ID and instance ID. Every property replaces the assignment.
 *
 * @see https://learn.microsoft.com/azure/key-vault/managed-hsm/role-management
 *
 * ### Granting HSM Roles
 * **Example:** Let a managed identity use every key
 * ```typescript
 * yield* Azure.KeyVault.ManagedHsmRoleAssignment("AppCryptoUser", {
 *   managedHsm: hsm.managedHsmName,
 *   scope: "/keys",
 *   roleDefinitionId: Azure.KeyVault.ManagedHsmBuiltInRole.CryptoUser,
 *   principalId: identity.principalId,
 * });
 * ```
 *
 * **Example:** Grant a custom role on the whole HSM
 * ```typescript
 * const role = yield* Azure.KeyVault.ManagedHsmRoleDefinition("BackupStarter", {
 *   managedHsm: hsm.managedHsmName,
 *   dataActions: ["Microsoft.KeyVault/managedHsm/backup/start/action"],
 * });
 * yield* Azure.KeyVault.ManagedHsmRoleAssignment("OperatorBackups", {
 *   managedHsm: hsm.managedHsmName,
 *   roleDefinitionId: role.roleDefinitionId,
 *   principalId: operator.principalId,
 * });
 * ```
 *
 * @resource
 */
export const ManagedHsmRoleAssignment = Resource<ManagedHsmRoleAssignment>(
  "Azure.KeyVault.ManagedHsmRoleAssignment",
);

const getAssignment = (managedHsm: string, scope: string, roleAssignmentName: string) =>
  orUndefinedIfNotFound(
    admin.GetRoleAssignment({
      vaultBaseUrl: managedHsmUri(managedHsm),
      scope,
      roleAssignmentName,
    }),
  );

const toAttrs = (
  managedHsm: string,
  scope: string,
  name: string,
  assignment: admin.RoleAssignment,
): ManagedHsmRoleAssignment["Attributes"] => ({
  managedHsm,
  roleAssignmentName: name,
  roleAssignmentId:
    assignment.id ?? `${scope}/providers/Microsoft.Authorization/roleAssignments/${name}`,
  scope: assignment.properties?.scope ?? scope,
  roleDefinitionId: assignment.properties?.roleDefinitionId ?? "",
  principalId: assignment.properties?.principalId ?? "",
});

export const ManagedHsmRoleAssignmentProvider = () =>
  Provider.succeed(ManagedHsmRoleAssignment, {
    stables: [
      "managedHsm",
      "roleAssignmentName",
      "roleAssignmentId",
      "scope",
      "roleDefinitionId",
      "principalId",
    ],

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // The HSM, role and principal are stable attributes upstream; an
      // unresolved one means its resource is being replaced.
      if (
        !("managedHsm" in news) ||
        !("roleDefinitionId" in news) ||
        !("principalId" in news) ||
        !isResolved(news.managedHsm) ||
        !isResolved(news.roleDefinitionId) ||
        !isResolved(news.principalId)
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved<ManagedHsmRoleAssignmentProps>(news)) return undefined;
      if (
        lower(news.managedHsm) !== lower(output.managedHsm) ||
        normalizeHsmScope(news.scope ?? "/") !== normalizeHsmScope(output.scope) ||
        roleGuidOf(news.roleDefinitionId) !== roleGuidOf(output.roleDefinitionId) ||
        lower(news.principalId) !== lower(output.principalId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const managedHsm = output?.managedHsm ?? olds?.managedHsm;
      if (managedHsm === undefined) return undefined;
      const scope = output?.scope ?? olds?.scope ?? "/";
      const name = output?.roleAssignmentName ?? (yield* deterministicGuid(id, instanceId));
      const observed = yield* getAssignment(managedHsm, scope, name);
      // The GUID name is derived from this stack, stage, logical ID and
      // instance ID, so an assignment under it is ours.
      return observed === undefined ? undefined : toAttrs(managedHsm, scope, name, observed);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const { managedHsm } = news;
      const scope = news.scope ?? "/";
      const name = output?.roleAssignmentName ?? (yield* deterministicGuid(id, instanceId));
      const roleDefinitionId = managedHsmRoleDefinitionIdOf(news.roleDefinitionId);

      // Observe. Nothing on an assignment is mutable: ensure only.
      const observed = yield* getAssignment(managedHsm, scope, name);
      if (observed === undefined) {
        yield* admin
          .CreateRoleAssignment({
            vaultBaseUrl: managedHsmUri(managedHsm),
            scope,
            roleAssignmentName: name,
            properties: { roleDefinitionId, principalId: news.principalId },
          })
          .pipe(
            Effect.catchTag("RoleAssignmentExists", () => Effect.void),
            // A freshly created identity takes a moment to replicate
            // through Microsoft Entra ID.
            Effect.retry({
              while: (e) => e._tag === "PrincipalNotFound",
              schedule: Schedule.spaced("5 seconds"),
              times: 12,
            }),
          );
      }

      const fresh = yield* waitForProvisioned(
        `managed HSM role assignment ${name}`,
        getAssignment(managedHsm, scope, name),
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(managedHsm, scope, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        admin.DeleteRoleAssignment({
          vaultBaseUrl: managedHsmUri(output.managedHsm),
          scope: output.scope,
          roleAssignmentName: output.roleAssignmentName,
        }),
      );
      yield* waitUntilGone(
        `managed HSM role assignment ${output.roleAssignmentName}`,
        getAssignment(output.managedHsm, output.scope, output.roleAssignmentName),
        { interval: "2 seconds", times: 15 },
      );
    }),
  });
