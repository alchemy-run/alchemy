import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as automanage from "@distilled.cloud/azure/automanage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getVersion = (
  resourceGroupName: string,
  configurationProfileName: string,
  versionName: string,
) =>
  Effect.gen(function* () {
    return yield* automanage.GetConfigurationProfilesVersion({
      subscriptionId: yield* subscription,
      resourceGroupName,
      configurationProfileName,
      versionName,
    });
  });

const program = (props: {
  configuration: Record<string, unknown>;
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const profile = yield* Azure.Automanage.ConfigurationProfile("Profile", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      configuration: { "AzureSecurityBaseline/Enable": true },
    });
    const version = yield* Azure.Automanage.ConfigurationProfileVersion(
      "Version",
      {
        resourceGroup: group.resourceGroupName,
        configurationProfile: profile.configurationProfileName,
        location: "eastus",
        configuration: props.configuration,
        tags: props.tags,
      },
    );
    return { group, profile, version };
  });

// Free and synchronous, but a subscription not already onboarded to the
// retiring Automanage service cannot create the parent profile (`AutomanageSubscriptionNotSupported`, see the probe in
// ConfigurationProfile.test.ts). Runs with AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, update tags, replace, and delete a configuration profile version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, profile, version } = yield* stack.deploy(
        program({
          configuration: { "AzureSecurityBaseline/Enable": true },
          tags: { env: "test" },
        }),
      );
      const get = (name: string) =>
        getVersion(
          group.resourceGroupName,
          profile.configurationProfileName,
          name,
        );
      const observed = yield* get(version.versionName);
      expect(observed.properties?.configuration).toMatchObject({
        "AzureSecurityBaseline/Enable": true,
      });
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Version");

      // In place: tags.
      const updated = yield* stack.deploy(
        program({
          configuration: { "AzureSecurityBaseline/Enable": true },
          tags: { env: "prod" },
        }),
      );
      expect(updated.version.configurationProfileVersionId).toEqual(
        version.configurationProfileVersionId,
      );
      expect((yield* get(version.versionName)).tags?.env).toEqual("prod");

      // Replacement: versions are immutable snapshots.
      const replaced = yield* stack.deploy(
        program({
          configuration: {
            "AzureSecurityBaseline/Enable": true,
            "Antimalware/Enable": true,
          },
          tags: { env: "prod" },
        }),
      );
      expect(replaced.version.versionName).not.toEqual(version.versionName);
      expect(
        (yield* get(replaced.version.versionName)).properties?.configuration,
      ).toMatchObject({ "Antimalware/Enable": true });
      expect(yield* waitGone(get(version.versionName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.version.versionName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

// Ungated probe: a version cannot be written without its parent profile,
// which a non-onboarded subscription cannot create. Only a resource group is created (free).
test.provider(
  "a version without a parent profile is rejected",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const error = yield* automanage
        .ConfigurationProfilesVersionsCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          configurationProfileName: "probe",
          versionName: "1.0",
          location: "eastus",
          properties: {
            configuration: { "AzureSecurityBaseline/Enable": true },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
      expect(
        yield* waitGone(getVersion(group.resourceGroupName, "probe", "1.0")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
