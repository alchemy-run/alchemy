import * as Azure from "@alchemy.run/azure";
import * as management from "@distilled.cloud/azure/management";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const tags = ["provider:azure", "provider:azure:management", "live"];

/**
 * Hierarchy settings are a tenant-wide singleton: changing them changes
 * where every new subscription of the tenant lands and who may create
 * management groups, for every concurrent test. The lifecycle only runs
 * with `AZURE_TEST_MG_HIERARCHY_SETTINGS=1` and needs settings/write on the
 * tenant root group, which the testing identity lacks (see the probe).
 */
const runHierarchySettings = !!process.env.AZURE_TEST_MG_HIERARCHY_SETTINGS;

/** The tenant's settings, or `undefined` when none were ever written. */
const getSettings = (groupId: string) =>
  management.GetHierarchySettings({ groupId }).pipe(
    Effect.map((s) => s.properties),
    Effect.catchTag(["ManagementGroupNotFound", "NotFound", "ResourceNotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const settingsUntil = (
  groupId: string,
  matches: (s: management.HierarchySettingsProperties | undefined) => boolean,
) =>
  getSettings(groupId).pipe(
    Effect.repeat({ schedule: Schedule.spaced("5 seconds"), until: matches, times: 24 }),
  );

const groupName = (id: string | undefined) => id?.split("/").pop()?.toLowerCase();

// Ungated, read-only probe: the testing identity has no access on the
// tenant root group, so reading its settings fails with a typed
// `AuthorizationFailed` (`Microsoft.Management/managementGroups/settings/read`).
test.provider(
  "the testing identity cannot read the tenant's hierarchy settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { tenantId } = yield* Azure.AzureEnvironment.current;
      const error = yield* management.GetHierarchySettings({ groupId: tenantId }).pipe(Effect.flip);
      expect(error._tag).toEqual("AuthorizationFailed");
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);

// $0, ~3-10 min: a new management group is unusable until the creator's
// Owner grant propagates.
test.provider.skipIf(!runHierarchySettings)(
  "set, update, and reset the tenant's hierarchy settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { tenantId } = yield* Azure.AzureEnvironment.current;
      // Captured so the tenant's own settings are restored afterwards.
      const original = yield* getSettings(tenantId);

      const program = (props: { useSandbox: boolean; requireAuthorization: boolean }) =>
        Effect.gen(function* () {
          const sandbox = yield* Azure.Management.ManagementGroup("Sandbox", {
            displayName: "Alchemy hierarchy settings test",
          });
          const settings = yield* Azure.Management.HierarchySettings("Settings", {
            defaultManagementGroup: props.useSandbox ? sandbox.managementGroupId : undefined,
            requireAuthorizationForGroupCreation: props.requireAuthorization,
          });
          return { sandbox, settings };
        });

      const { sandbox, settings } = yield* stack.deploy(
        program({ useSandbox: true, requireAuthorization: false }),
      );
      expect(settings.groupName).toEqual(tenantId);
      expect(groupName(settings.defaultManagementGroup)).toEqual(sandbox.groupName.toLowerCase());
      expect(settings.requireAuthorizationForGroupCreation).toEqual(false);
      const observed = yield* settingsUntil(
        tenantId,
        (s) => groupName(s?.defaultManagementGroup) === sandbox.groupName.toLowerCase(),
      );
      expect(groupName(observed?.defaultManagementGroup)).toEqual(sandbox.groupName.toLowerCase());

      // In place: back to the root group, and require authorization.
      const updated = yield* stack.deploy(
        program({ useSandbox: false, requireAuthorization: true }),
      );
      expect(updated.settings.settingsId).toEqual(settings.settingsId);
      const reobserved = yield* settingsUntil(
        tenantId,
        (s) => s?.requireAuthorizationForGroupCreation === true,
      );
      expect(reobserved?.requireAuthorizationForGroupCreation).toEqual(true);
      expect(groupName(reobserved?.defaultManagementGroup ?? tenantId)).toEqual(
        tenantId.toLowerCase(),
      );

      // Delete resets the settings to the Azure defaults.
      yield* stack.destroy();
      const reset = yield* settingsUntil(
        tenantId,
        (s) => (s?.requireAuthorizationForGroupCreation ?? false) === false,
      );
      expect(reset?.requireAuthorizationForGroupCreation ?? false).toEqual(false);

      if (original !== undefined) {
        yield* management.HierarchySettingsCreateOrUpdate({
          groupId: tenantId,
          properties: {
            requireAuthorizationForGroupCreation: original.requireAuthorizationForGroupCreation,
            defaultManagementGroup: original.defaultManagementGroup,
          },
        });
      }
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
