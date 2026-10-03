import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as trafficmanager from "@distilled.cloud/azure/trafficmanager";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getEndpoint = (
  resourceGroupName: string,
  profileName: string,
  endpointName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* trafficmanager.GetEndpoint({
      subscriptionId,
      resourceGroupName,
      profileName,
      endpointType: "ExternalEndpoints",
      endpointName,
    });
  });

const endpointGone = (
  resourceGroupName: string,
  profileName: string,
  endpointName: string,
) =>
  getEndpoint(resourceGroupName, profileName, endpointName).pipe(
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

const program = (
  endpoints: {
    id: string;
    name?: string;
    target: string;
    priority: number;
    endpointStatus?: "Enabled" | "Disabled";
  }[],
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const profile = yield* Azure.TrafficManager.Profile("Profile", {
      resourceGroup: group.resourceGroupName,
      trafficRoutingMethod: "Priority",
    });
    const created = [];
    // Sequential: Traffic Manager rejects concurrent writes to one profile.
    for (const e of endpoints) {
      created.push(
        yield* Azure.TrafficManager.Endpoint(e.id, {
          resourceGroup: group.resourceGroupName,
          profile: profile.profileName,
          endpointType: "ExternalEndpoints",
          name: e.name,
          target: e.target,
          priority: e.priority,
          endpointStatus: e.endpointStatus,
        }),
      );
    }
    return { group, profile, endpoints: created };
  });

// External endpoints cost ~$0.54/endpoint-month for health checks; a few
// minutes is ~$0.
test.provider(
  "create, update, replace, and delete traffic manager endpoints",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program([
          { id: "Primary", target: "primary.example.com", priority: 1 },
          { id: "Secondary", target: "secondary.example.com", priority: 2 },
        ]),
      );
      const rg = created.group.resourceGroupName;
      const profileName = created.profile.profileName;
      const [primary, secondary] = created.endpoints;
      expect(primary!.endpointId).toContain("/externalEndpoints/");
      expect(primary!.priority).toEqual(1);
      const observed = yield* getEndpoint(
        rg,
        profileName,
        primary!.endpointName,
      );
      expect(observed.properties?.target).toEqual("primary.example.com");
      expect(observed.properties?.priority).toEqual(1);
      const observed2 = yield* getEndpoint(
        rg,
        profileName,
        secondary!.endpointName,
      );
      expect(observed2.properties?.target).toEqual("secondary.example.com");

      // In-place update: new target and status on the primary.
      const updated = yield* stack.deploy(
        program([
          {
            id: "Primary",
            target: "primary-v2.example.com",
            priority: 1,
            endpointStatus: "Disabled",
          },
          { id: "Secondary", target: "secondary.example.com", priority: 2 },
        ]),
      );
      expect(updated.endpoints[0]!.endpointId).toEqual(primary!.endpointId);
      const reobserved = yield* getEndpoint(
        rg,
        profileName,
        primary!.endpointName,
      );
      expect(reobserved.properties?.target).toEqual("primary-v2.example.com");
      expect(reobserved.properties?.endpointStatus).toEqual("Disabled");

      // Renaming replaces the endpoint; dropping one deletes it.
      const renamed = yield* stack.deploy(
        program([
          {
            id: "Primary",
            name: "alchemy-renamed-endpoint",
            target: "primary-v2.example.com",
            priority: 1,
          },
        ]),
      );
      expect(renamed.endpoints[0]!.endpointName).toEqual(
        "alchemy-renamed-endpoint",
      );
      const replacement = yield* getEndpoint(
        rg,
        profileName,
        "alchemy-renamed-endpoint",
      );
      expect(replacement.properties?.endpointStatus).toEqual("Enabled");
      expect(
        yield* endpointGone(rg, profileName, primary!.endpointName),
      ).toEqual("gone");
      expect(
        yield* endpointGone(rg, profileName, secondary!.endpointName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* endpointGone(rg, profileName, "alchemy-renamed-endpoint"),
      ).toEqual("gone");
    }),
  {
    tags: ["provider:azure", "provider:azure:trafficmanager", "live"],
    timeout: 600_000,
  },
);
