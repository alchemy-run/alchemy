import * as management from "@distilled.cloud/azure/management";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ignoreNotFound, orUndefinedIfNotFound, waitForProvisioned } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { managementGroupIdOf, managementGroupNameOf } from "./ManagementGroup.ts";

export interface HierarchySettingsProps {
  /**
   * Management group the settings apply to: its ARM ID or name. Azure only
   * accepts the tenant root group.
   *
   * :::caution
   * Changing it replaces the settings.
   * :::
   * @default the tenant root group (the Microsoft Entra tenant ID)
   */
  managementGroupId?: string;
  /**
   * Require `Microsoft.Management/managementGroups/write` on the root group
   * to create management groups directly under the root.
   * @default false
   */
  requireAuthorizationForGroupCreation?: boolean;
  /**
   * Management group new subscriptions are placed under: its ARM ID or
   * name, e.g. `group.managementGroupId`.
   * @default the tenant root group
   */
  defaultManagementGroup?: string;
}

export interface HierarchySettings extends Resource<
  "Azure.Management.HierarchySettings",
  HierarchySettingsProps,
  {
    /** Name of the management group the settings apply to. */
    groupName: string;
    /**
     * ARM ID of the settings,
     * `/providers/Microsoft.Management/managementGroups/{group}/settings/default`.
     */
    settingsId: string;
    /** Microsoft Entra tenant of the hierarchy. */
    tenantId: string | undefined;
    /** Whether creating groups under the root requires authorization. */
    requireAuthorizationForGroupCreation: boolean;
    /** ARM ID of the management group new subscriptions are placed under. */
    defaultManagementGroup: string;
  },
  never,
  Providers
> {}

/**
 * The hierarchy settings of a Microsoft Entra tenant's management groups
 * (`Microsoft.Management/managementGroups/settings`): where new
 * subscriptions land, and whether creating management groups under the
 * root needs permission.
 *
 * See the [Azure documentation](https://learn.microsoft.com/azure/governance/management-groups/how-to/protect-resource-hierarchy).
 *
 * The settings are a tenant-wide singleton on the tenant root group.
 * Deleting this resource resets both settings to the Azure defaults (new
 * subscriptions go to the root group; anyone can create groups). The
 * deploying identity needs `Microsoft.Management/managementGroups/settings/write`
 * on the root group, for example the Hierarchy Settings Administrator role.
 *
 * :::caution
 * Changing `managementGroupId` replaces the settings.
 * :::
 *
 * ### Protecting the Hierarchy
 * **Example:** Put new subscriptions in a sandbox group
 * ```typescript
 * const sandbox = yield* Azure.Management.ManagementGroup("sandbox", {
 *   displayName: "Sandbox",
 * });
 * yield* Azure.Management.HierarchySettings("hierarchy", {
 *   defaultManagementGroup: sandbox.managementGroupId,
 *   requireAuthorizationForGroupCreation: true,
 * });
 * ```
 *
 * @resource
 */
export const HierarchySettings = Resource<HierarchySettings>("Azure.Management.HierarchySettings");

type ObservedSettings = management.GetHierarchySettingsResponse;

const getSettings = (groupId: string) =>
  orUndefinedIfNotFound(
    management
      .GetHierarchySettings({ groupId })
      .pipe(Effect.catchTag("ManagementGroupNotFound", () => Effect.succeed(undefined))),
  );

const sameGroup = (a: string | undefined, b: string) =>
  a !== undefined &&
  managementGroupNameOf(a).toLowerCase() === managementGroupNameOf(b).toLowerCase();

const toAttrs = (
  groupName: string,
  observed: ObservedSettings,
): HierarchySettings["Attributes"] => ({
  groupName,
  settingsId:
    observed.id ?? `/providers/Microsoft.Management/managementGroups/${groupName}/settings/default`,
  tenantId: observed.properties?.tenantId,
  requireAuthorizationForGroupCreation:
    observed.properties?.requireAuthorizationForGroupCreation ?? false,
  defaultManagementGroup: managementGroupIdOf(
    observed.properties?.defaultManagementGroup ?? groupName,
  ),
});

export const HierarchySettingsProvider = () =>
  Provider.succeed(HierarchySettings, {
    stables: ["groupName", "settingsId", "tenantId"],

    // The settings carry no ownership marker, and reading them needs access
    // on the tenant root group, so there is no `list`.

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.managementGroupId !== undefined &&
        !sameGroup(news.managementGroupId, output.groupName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { tenantId } = yield* AzureEnvironment.current;
      const groupName =
        output?.groupName ??
        (olds?.managementGroupId !== undefined
          ? managementGroupNameOf(olds.managementGroupId)
          : tenantId);
      const observed = yield* getSettings(groupName);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(groupName, observed);
      // The settings carry no marker; only recorded ones are ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { tenantId } = yield* AzureEnvironment.current;
      const groupName =
        news.managementGroupId !== undefined
          ? managementGroupNameOf(news.managementGroupId)
          : (output?.groupName ?? tenantId);
      const desired = {
        requireAuthorizationForGroupCreation: news.requireAuthorizationForGroupCreation ?? false,
        defaultManagementGroup: managementGroupIdOf(news.defaultManagementGroup ?? groupName),
      };
      const matches = (observed: ObservedSettings | undefined) =>
        observed !== undefined &&
        (observed.properties?.requireAuthorizationForGroupCreation ?? false) ===
          desired.requireAuthorizationForGroupCreation &&
        sameGroup(
          observed.properties?.defaultManagementGroup ?? groupName,
          desired.defaultManagementGroup,
        );

      // Observe.
      let observed = yield* getSettings(groupName);

      if (observed === undefined) {
        // Ensure: the settings object does not exist until first written.
        yield* management.HierarchySettingsCreateOrUpdate({
          groupId: groupName,
          properties: desired,
        });
      } else if (!matches(observed)) {
        // Sync: PATCH both settings to the desired values.
        yield* management.UpdateHierarchySettings({
          groupId: groupName,
          properties: desired,
        });
      }

      // Reads trail writes by a few seconds.
      observed = yield* waitForProvisioned(
        `hierarchy settings of management group ${groupName}`,
        getSettings(groupName).pipe(Effect.map((s) => (matches(s) ? s : undefined))),
        () => undefined,
        { interval: "5 seconds", times: 12 },
      );

      return toAttrs(groupName, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Resets both settings to the Azure defaults.
      yield* ignoreNotFound(management.DeleteHierarchySettings({ groupId: output.groupName }));
    }),
  });
