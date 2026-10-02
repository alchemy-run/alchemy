import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as synapse from "@distilled.cloud/azure/synapse";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { LOCATION, logLevel, untilGone } from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getHub = (resourceGroupName: string, privateLinkHubName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* synapse.GetPrivateLinkHub({
      subscriptionId,
      resourceGroupName,
      privateLinkHubName,
    });
  });

const program = (props: { tags: Record<string, string>; name?: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const hub = yield* Azure.Synapse.PrivateLinkHub("Hub", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      tags: props.tags,
    });
    return { group, hub };
  });

// Free; seconds.
test.provider(
  "create, update, replace, and delete a synapse private link hub",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, hub } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      expect(hub.privateLinkHubName).toMatch(/^[a-z0-9]{1,45}$/);
      const observed = yield* getHub(rg, hub.privateLinkHubName);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Hub");

      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.hub.privateLinkHubId).toEqual(hub.privateLinkHubId);
      const reobserved = yield* getHub(rg, hub.privateLinkHubName);
      expect(reobserved.tags?.env).toEqual("prod");

      const renamedName = `${hub.privateLinkHubName.slice(0, 40)}renm`;
      const renamed = yield* stack.deploy(
        program({ tags: { env: "prod" }, name: renamedName }),
      );
      expect(renamed.hub.privateLinkHubName).toEqual(renamedName);
      expect(yield* untilGone(getHub(rg, hub.privateLinkHubName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* untilGone(getHub(rg, renamedName))).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 600_000,
  },
);
