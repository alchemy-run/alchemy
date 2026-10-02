import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as aci from "@distilled.cloud/azure/containerinstance";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getProfile = (
  resourceGroupName: string,
  containerGroupProfileName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* aci.GetCGProfile({
      subscriptionId,
      resourceGroupName,
      containerGroupProfileName,
    });
  });

const profileGone = (resourceGroupName: string, name: string) =>
  getProfile(resourceGroupName, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: {
  image: string;
  location?: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const profile = yield* Azure.ContainerInstance.ContainerGroupProfile(
      "Profile",
      {
        resourceGroup: group.resourceGroupName,
        location: props.location,
        containers: [
          {
            name: "web",
            image: props.image,
            cpu: 0.5,
            memoryInGB: 0.5,
            ports: [{ port: 80 }],
            environment: { MODE: "test" },
          },
        ],
        ipAddress: { type: "Public", ports: [{ port: 80, protocol: "TCP" }] },
        tags: props.tags,
      },
    );
    return { group, profile };
  });

// A profile is a template only: no compute, no cost.
test.provider(
  "create, update, replace, and delete a container group profile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, profile } = yield* stack.deploy(
        program({
          image: "mcr.microsoft.com/azuredocs/aci-helloworld:latest",
          tags: { env: "test" },
        }),
      );
      expect(profile.containerGroupProfileId).toContain(
        "/containerGroupProfiles/",
      );
      const observed = yield* getProfile(
        group.resourceGroupName,
        profile.containerGroupProfileName,
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.properties?.containers[0]?.properties.image).toEqual(
        "mcr.microsoft.com/azuredocs/aci-helloworld:latest",
      );
      const firstRevision = observed.properties?.revision;
      expect(profile.revision).toEqual(firstRevision);

      // A redeploy with no changes must not create a new revision.
      const same = yield* stack.deploy(
        program({
          image: "mcr.microsoft.com/azuredocs/aci-helloworld:latest",
          tags: { env: "test" },
        }),
      );
      expect(same.profile.revision).toEqual(firstRevision);

      // In-place: a new image creates a new revision; tags PATCH.
      const updated = yield* stack.deploy(
        program({
          image: "mcr.microsoft.com/azuredocs/aci-helloworld:v1",
          tags: { env: "prod" },
        }),
      );
      expect(updated.profile.containerGroupProfileId).toEqual(
        profile.containerGroupProfileId,
      );
      const reobserved = yield* getProfile(
        group.resourceGroupName,
        profile.containerGroupProfileName,
      );
      expect(reobserved.properties?.containers[0]?.properties.image).toEqual(
        "mcr.microsoft.com/azuredocs/aci-helloworld:v1",
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.properties?.revision).toBeGreaterThan(
        firstRevision ?? 0,
      );

      // A location change replaces the profile.
      const replaced = yield* stack.deploy(
        program({
          image: "mcr.microsoft.com/azuredocs/aci-helloworld:v1",
          location: "westus2",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.profile.location.toLowerCase()).toEqual("westus2");
      expect(replaced.profile.containerGroupProfileName).not.toEqual(
        profile.containerGroupProfileName,
      );
      expect(
        yield* profileGone(
          group.resourceGroupName,
          profile.containerGroupProfileName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* profileGone(
          group.resourceGroupName,
          replaced.profile.containerGroupProfileName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerinstance", "live"],
    timeout: 900_000,
  },
);
