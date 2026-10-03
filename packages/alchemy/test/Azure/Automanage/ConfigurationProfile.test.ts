import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as automanage from "@distilled.cloud/azure/automanage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getProfile = (
  resourceGroupName: string,
  configurationProfileName: string,
) =>
  Effect.gen(function* () {
    return yield* automanage.GetConfigurationProfile({
      subscriptionId: yield* subscription,
      resourceGroupName,
      configurationProfileName,
    });
  });

const program = (props: {
  location: string;
  configuration: Record<string, unknown>;
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const profile = yield* Azure.Automanage.ConfigurationProfile("Profile", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      configuration: props.configuration,
      tags: props.tags,
    });
    return { group, profile };
  });

// Configuration profiles are free and provision synchronously, but the
// free-trial subscription rejects every profile PUT with
// `AutomanageSubscriptionNotSupported` (400 InvalidSubscriptionState,
// "Subscription state: -1"). Runs with AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a configuration profile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, profile } = yield* stack.deploy(
        program({
          location: "eastus",
          configuration: { "AzureSecurityBaseline/Enable": true },
          tags: { env: "test" },
        }),
      );
      expect(profile.configurationProfileId).toContain(
        "/configurationProfiles/",
      );
      const observed = yield* getProfile(
        group.resourceGroupName,
        profile.configurationProfileName,
      );
      expect(observed.properties?.configuration).toMatchObject({
        "AzureSecurityBaseline/Enable": true,
      });
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Profile");

      // In place: configuration and tags.
      const updated = yield* stack.deploy(
        program({
          location: "eastus",
          configuration: {
            "AzureSecurityBaseline/Enable": true,
            "Antimalware/Enable": true,
          },
          tags: { env: "prod" },
        }),
      );
      expect(updated.profile.configurationProfileId).toEqual(
        profile.configurationProfileId,
      );
      const reobserved = yield* getProfile(
        group.resourceGroupName,
        profile.configurationProfileName,
      );
      expect(reobserved.properties?.configuration).toMatchObject({
        "AzureSecurityBaseline/Enable": true,
        "Antimalware/Enable": true,
      });
      expect(reobserved.tags?.env).toEqual("prod");

      // Tags only (PATCH path).
      yield* stack.deploy(
        program({
          location: "eastus",
          configuration: {
            "AzureSecurityBaseline/Enable": true,
            "Antimalware/Enable": true,
          },
          tags: { env: "staging" },
        }),
      );
      const patched = yield* getProfile(
        group.resourceGroupName,
        profile.configurationProfileName,
      );
      expect(patched.tags?.env).toEqual("staging");
      expect(patched.tags?.["alchemy::id"]).toEqual("Profile");

      // Replacement: location is immutable.
      const replaced = yield* stack.deploy(
        program({
          location: "westus2",
          configuration: { "AzureSecurityBaseline/Enable": true },
          tags: { env: "staging" },
        }),
      );
      expect(replaced.profile.configurationProfileName).not.toEqual(
        profile.configurationProfileName,
      );
      const replacedObserved = yield* getProfile(
        group.resourceGroupName,
        replaced.profile.configurationProfileName,
      );
      expect(replacedObserved.location.toLowerCase()).toEqual("westus2");
      expect(
        yield* waitGone(
          getProfile(group.resourceGroupName, profile.configurationProfileName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getProfile(
            group.resourceGroupName,
            replaced.profile.configurationProfileName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

// Ungated probe: the trial subscription rejects profile creation with the
// typed subscription-state error. Only a resource group is created (free).
test.provider(
  "the trial subscription rejects configuration profiles with a typed error",
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
      const subscriptionId = yield* subscription;
      const error = yield* automanage
        .ConfigurationProfilesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          configurationProfileName: "probe",
          location: "eastus",
          properties: {
            configuration: { "AzureSecurityBaseline/Enable": true },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("AutomanageSubscriptionNotSupported");
      expect(
        yield* waitGone(getProfile(group.resourceGroupName, "probe")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
