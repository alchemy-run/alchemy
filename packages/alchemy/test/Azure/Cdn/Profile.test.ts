import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cdn from "@distilled.cloud/azure/cdn";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  FRONT_DOOR_TIMEOUT,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getProfile = (resourceGroupName: string, profileName: string) =>
  Effect.gen(function* () {
    return yield* cdn.GetProfile({
      subscriptionId: yield* subscription,
      resourceGroupName,
      profileName,
    });
  });

const program = (props: {
  name?: string;
  timeout: number;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const profile = yield* Azure.Cdn.Profile("FrontDoor", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      originResponseTimeoutSeconds: props.timeout,
      tags: props.tags,
    });
    return { group, profile };
  });

// Front Door Standard (~$0.05/hour, a few minutes to create, 5-15 minutes to
// delete). Free Trial subscriptions cannot create Front Door profiles.
test.provider.skipIf(!runPaidOnly)(
  "profile lifecycle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, profile } = yield* stack.deploy(
        program({ timeout: 60, tags: { env: "test" } }),
      );
      expect(profile.sku).toEqual("Standard_AzureFrontDoor");
      expect(profile.frontDoorId).toBeDefined();
      const observed = yield* getProfile(
        group.resourceGroupName,
        profile.profileName,
      );
      expect(observed.properties?.originResponseTimeoutSeconds).toEqual(60);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("FrontDoor");

      // In place: timeout and tags.
      const updated = yield* stack.deploy(
        program({ timeout: 120, tags: { env: "prod" } }),
      );
      expect(updated.profile.profileId).toEqual(profile.profileId);
      const reobserved = yield* getProfile(
        group.resourceGroupName,
        profile.profileName,
      );
      expect(reobserved.properties?.originResponseTimeoutSeconds).toEqual(120);
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-cdn-renamed",
          timeout: 120,
          tags: { env: "prod" },
        }),
      );
      expect(replaced.profile.profileName).toEqual("alchemy-cdn-renamed");
      expect(
        yield* waitGone(
          getProfile(group.resourceGroupName, profile.profileName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getProfile(group.resourceGroupName, replaced.profile.profileName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: FRONT_DOOR_TIMEOUT },
);

// Ungated probe (free: the create is rejected): the Free Trial subscription
// refuses Front Door profiles with a typed error, both through the provider
// and the SDK. Test titles stay short: Microsoft.Cdn rejects resource group
// names longer than 80 characters.
test.provider(
  "free trial probe",
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
      const error = yield* cdn
        .CreateProfile({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          profileName: "alchemy-probe",
          location: "global",
          sku: { name: "Standard_AzureFrontDoor" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("FrontDoorFreeTrialForbidden");

      const deployError = yield* stack
        .deploy(
          Effect.gen(function* () {
            const group = yield* Azure.Resources.ResourceGroup("Group", {
              location: "eastus",
            });
            const profile = yield* Azure.Cdn.Profile("FrontDoor", {
              resourceGroup: group.resourceGroupName,
            });
            return { group, profile };
          }),
        )
        .pipe(Effect.flip);
      expect(JSON.stringify(deployError)).toContain(
        "FrontDoorFreeTrialForbidden",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(getProfile(group.resourceGroupName, "alchemy-probe")),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
