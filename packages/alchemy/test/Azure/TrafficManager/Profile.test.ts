import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as trafficmanager from "@distilled.cloud/azure/trafficmanager";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getProfile = (resourceGroupName: string, profileName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* trafficmanager.GetProfile({
      subscriptionId,
      resourceGroupName,
      profileName,
    });
  });

const profileGone = (resourceGroupName: string, profileName: string) =>
  getProfile(resourceGroupName, profileName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["NotFound", "ResourceNotFound", "ResourceGroupNotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const program = (props: {
  relativeName?: string;
  trafficRoutingMethod: Azure.TrafficManager.TrafficRoutingMethod;
  ttl?: number;
  monitorConfig?: Azure.TrafficManager.TrafficManagerMonitorConfig;
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const profile = yield* Azure.TrafficManager.Profile("Profile", {
      resourceGroup: group.resourceGroupName,
      ...props,
    });
    return { group, profile };
  });

// Traffic Manager bills per million DNS queries and per monitored endpoint
// month; an empty profile for a few minutes costs ~$0.
test.provider(
  "create, update, replace, and delete a traffic manager profile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          trafficRoutingMethod: "Priority",
          monitorConfig: { protocol: "HTTP", port: 80, path: "/health" },
          tags: { env: "test" },
        }),
      );
      const rg = created.group.resourceGroupName;
      const profile = created.profile;
      expect(profile.fqdn).toEqual(
        `${profile.profileName.toLowerCase()}.trafficmanager.net`,
      );
      expect(profile.trafficRoutingMethod).toEqual("Priority");
      expect(profile.ttl).toEqual(60);
      expect(profile.tags).toEqual({ env: "test" });
      const observed = yield* getProfile(rg, profile.profileName);
      expect(observed.location).toEqual("global");
      expect(observed.properties?.monitorConfig?.path).toEqual("/health");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.alchemy_id).toEqual("Profile");

      // In-place update: routing method, TTL, monitor, tags.
      const updated = yield* stack.deploy(
        program({
          trafficRoutingMethod: "Weighted",
          ttl: 30,
          monitorConfig: {
            protocol: "HTTPS",
            port: 443,
            path: "/healthz",
            expectedStatusCodeRanges: [{ min: 200, max: 299 }],
          },
          tags: { env: "prod" },
        }),
      );
      expect(updated.profile.profileName).toEqual(profile.profileName);
      expect(updated.profile.profileId).toEqual(profile.profileId);
      const reobserved = yield* getProfile(rg, profile.profileName);
      expect(reobserved.properties?.trafficRoutingMethod).toEqual("Weighted");
      expect(reobserved.properties?.dnsConfig?.ttl).toEqual(30);
      expect(reobserved.properties?.monitorConfig?.protocol).toEqual("HTTPS");
      expect(reobserved.properties?.monitorConfig?.port).toEqual(443);
      expect(reobserved.properties?.monitorConfig?.path).toEqual("/healthz");
      expect(
        reobserved.properties?.monitorConfig?.expectedStatusCodeRanges,
      ).toEqual([{ min: 200, max: 299 }]);
      expect(reobserved.tags?.env).toEqual("prod");

      // Changing the DNS label replaces the profile.
      const relativeName = `${profile.profileName.toLowerCase().slice(0, 58)}-v2`;
      const replaced = yield* stack.deploy(
        program({
          relativeName,
          trafficRoutingMethod: "Weighted",
          ttl: 30,
          tags: { env: "prod" },
        }),
      );
      expect(replaced.profile.relativeName).toEqual(relativeName);
      expect(replaced.profile.fqdn).toEqual(
        `${relativeName}.trafficmanager.net`,
      );
      expect(replaced.profile.profileName).not.toEqual(profile.profileName);
      expect(yield* profileGone(rg, profile.profileName)).toEqual("gone");
      const fresh = yield* getProfile(rg, replaced.profile.profileName);
      expect(fresh.properties?.dnsConfig?.relativeName).toEqual(relativeName);

      yield* stack.destroy();
      expect(yield* profileGone(rg, replaced.profile.profileName)).toEqual(
        "gone",
      );
    }),
  {
    tags: ["provider:azure", "provider:azure:trafficmanager", "live"],
    timeout: 600_000,
  },
);
