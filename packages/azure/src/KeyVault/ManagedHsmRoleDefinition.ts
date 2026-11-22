import * as admin from "@distilled.cloud/azure/keyvault-administration";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
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
import {
  descriptionWithMarker,
  deterministicGuid,
  ownershipMarker,
} from "../Authorization/Ownership.ts";
import type { Providers } from "../Providers.ts";
import { lower } from "./common.ts";

/** A Managed HSM data action, e.g. `Microsoft.KeyVault/managedHsm/backup/start/action`. */
export type ManagedHsmDataAction = admin.DataAction;

export interface ManagedHsmRoleDefinitionProps {
  /** Name of the managed HSM the role is defined in. Changing it replaces the role. */
  managedHsm: string;
  /**
   * Display name of the role, unique within the HSM.
   * @default a unique name generated from the app, stage and logical ID
   */
  roleName?: string;
  /**
   * Description of the role. Alchemy appends an ownership marker
   * (`[alchemy <stack>/<stage>/<id>]`) because HSM roles have no tags.
   */
  description?: string;
  /** Data actions the role grants. */
  dataActions: ManagedHsmDataAction[];
  /** Data actions excluded from `dataActions`. */
  notDataActions?: ManagedHsmDataAction[];
}

export interface ManagedHsmRoleDefinition extends Resource<
  "Azure.KeyVault.ManagedHsmRoleDefinition",
  ManagedHsmRoleDefinitionProps,
  {
    /** Name of the managed HSM. */
    managedHsm: string;
    /** Role-definition name (a GUID). */
    roleDefinitionName: string;
    /**
     * Role-definition ID
     * (`Microsoft.KeyVault/providers/Microsoft.Authorization/roleDefinitions/{guid}`),
     * usable as a {@link ManagedHsmRoleAssignment}'s `roleDefinitionId`.
     */
    roleDefinitionId: string;
    /** Display name of the role. */
    roleName: string;
    /** Data actions the role grants. */
    dataActions: string[];
  },
  never,
  Providers
> {}

/**
 * A custom role in a Managed HSM's local RBAC: a named set of HSM data
 * actions, granted with a {@link ManagedHsmRoleAssignment}.
 *
 * Managed HSM data-plane access is controlled by the HSM's own (local)
 * RBAC, not by Azure RBAC, so these roles live in the HSM, at scope `/`.
 * The HSM must be activated (its security domain downloaded) first.
 *
 * HSM roles cannot be tagged, so Alchemy records ownership as a
 * `[alchemy <stack>/<stage>/<id>]` marker at the end of the description.
 * The role's GUID name is derived from the stack, stage, logical ID and
 * instance ID.
 *
 * @see https://learn.microsoft.com/azure/key-vault/managed-hsm/custom-role
 *
 * ### Defining a Custom HSM Role
 * **Example:** A role that can only start backups
 * ```typescript
 * const role = yield* Azure.KeyVault.ManagedHsmRoleDefinition("BackupStarter", {
 *   managedHsm: hsm.managedHsmName,
 *   dataActions: ["Microsoft.KeyVault/managedHsm/backup/start/action"],
 * });
 * ```
 *
 * @resource
 */
export const ManagedHsmRoleDefinition = Resource<ManagedHsmRoleDefinition>(
  "Azure.KeyVault.ManagedHsmRoleDefinition",
);

/** Data-plane endpoint of a managed HSM. */
export const managedHsmUri = (managedHsm: string) => `https://${managedHsm}.managedhsm.azure.net`;

/** Managed HSM role definitions only support the `/` scope. */
const SCOPE = "/";

const getDefinition = (managedHsm: string, roleDefinitionName: string) =>
  orUndefinedIfNotFound(
    admin.GetRoleDefinition({
      vaultBaseUrl: managedHsmUri(managedHsm),
      scope: SCOPE,
      roleDefinitionName,
    }),
  ).pipe(Effect.catchTag("RoleDefinitionNotFound", () => Effect.succeed(undefined)));

const sorted = (values: readonly string[] | undefined) =>
  [...(values ?? [])].sort((a, b) => a.localeCompare(b)).join(",");

const toAttrs = (
  managedHsm: string,
  name: string,
  definition: admin.RoleDefinition,
): ManagedHsmRoleDefinition["Attributes"] => ({
  managedHsm,
  roleDefinitionName: name,
  roleDefinitionId:
    definition.id ?? `Microsoft.KeyVault/providers/Microsoft.Authorization/roleDefinitions/${name}`,
  roleName: definition.properties?.roleName ?? "",
  dataActions: (definition.properties?.permissions ?? []).flatMap((p) => p.dataActions ?? []),
});

export const ManagedHsmRoleDefinitionProvider = () =>
  Provider.succeed(ManagedHsmRoleDefinition, {
    stables: ["managedHsm", "roleDefinitionName", "roleDefinitionId"],

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // The HSM name is a stable attribute upstream; an unresolved one means
      // the HSM is being replaced.
      if (!("managedHsm" in news) || !isResolved(news.managedHsm)) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (lower(news.managedHsm) !== lower(output.managedHsm)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const managedHsm = output?.managedHsm ?? olds?.managedHsm;
      if (managedHsm === undefined) return undefined;
      const name = output?.roleDefinitionName ?? (yield* deterministicGuid(id, instanceId));
      const observed = yield* getDefinition(managedHsm, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(managedHsm, name, observed);
      const marker = yield* ownershipMarker(id);
      return (observed.properties?.description ?? "").endsWith(marker) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const { managedHsm } = news;
      const name = output?.roleDefinitionName ?? (yield* deterministicGuid(id, instanceId));
      const roleName = news.roleName ?? (yield* createPhysicalName({ id, maxLength: 128 }));
      const description = descriptionWithMarker(news.description, yield* ownershipMarker(id));
      const permissions = [
        { dataActions: news.dataActions, notDataActions: news.notDataActions ?? [] },
      ];

      // Observe.
      const observed = (yield* getDefinition(managedHsm, name))?.properties;
      const observedPermission = observed?.permissions?.[0];

      // Ensure + sync. The PUT is a full-body upsert; skip it when every
      // mutable aspect already matches.
      if (
        observed === undefined ||
        observed.roleName !== roleName ||
        observed.description !== description ||
        (observed.permissions?.length ?? 0) !== 1 ||
        sorted(observedPermission?.dataActions) !== sorted(news.dataActions) ||
        sorted(observedPermission?.notDataActions) !== sorted(news.notDataActions)
      ) {
        yield* admin.RoleDefinitionsCreateOrUpdate({
          vaultBaseUrl: managedHsmUri(managedHsm),
          scope: SCOPE,
          roleDefinitionName: name,
          properties: {
            roleName,
            description,
            type: "CustomRole",
            permissions,
            assignableScopes: [SCOPE],
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `managed HSM role definition ${name}`,
        getDefinition(managedHsm, name).pipe(
          Effect.map((definition) =>
            definition?.properties?.roleName === roleName ? definition : undefined,
          ),
        ),
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(managedHsm, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        admin.DeleteRoleDefinition({
          vaultBaseUrl: managedHsmUri(output.managedHsm),
          scope: SCOPE,
          roleDefinitionName: output.roleDefinitionName,
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
        `managed HSM role definition ${output.roleDefinitionName}`,
        getDefinition(output.managedHsm, output.roleDefinitionName),
        { interval: "2 seconds", times: 15 },
      );
    }),
  });
