import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getHub = (resourceGroupName: string, virtualHubName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetVirtualHub({ subscriptionId, resourceGroupName, virtualHubName }),
  );

const program = (props: { sku: "Basic" | "Standard"; env: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const wan = yield* Azure.Network.VirtualWan("Wan", {
      resourceGroup: group.resourceGroupName,
      type: props.sku,
    });
    const hub = yield* Azure.Network.VirtualHub("Hub", {
      resourceGroup: group.resourceGroupName,
      virtualWanId: wan.virtualWanId,
      addressPrefix: "10.100.0.0/23",
      sku: props.sku,
      tags: { env: props.env },
    });
    return { group, wan, hub };
  });

const lifecycle = (sku: "Basic" | "Standard", skip: boolean) =>
  test.provider.skipIf(skip)(
    `create, update, and delete a ${sku} virtual hub`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { group, hub } = yield* stack.deploy(
          program({ sku, env: "test" }),
        );
        expect(hub.sku).toEqual(sku);
        const observed = yield* getHub(
          group.resourceGroupName,
          hub.virtualHubName,
        );
        expect(observed.properties?.provisioningState).toEqual("Succeeded");
        expect(observed.properties?.addressPrefix).toEqual("10.100.0.0/23");
        expect(observed.tags?.env).toEqual("test");

        const updated = yield* stack.deploy(program({ sku, env: "prod" }));
        expect(updated.hub.virtualHubId).toEqual(hub.virtualHubId);
        const reobserved = yield* getHub(
          group.resourceGroupName,
          hub.virtualHubName,
        );
        expect(reobserved.tags?.env).toEqual("prod");

        yield* stack.destroy();
        expect(
          yield* untilGone(getHub(group.resourceGroupName, hub.virtualHubName)),
        ).toEqual("gone");
      }).pipe(logLevel),
    { tags, timeout: 900_000 },
  );

// A Basic hub (in a Basic WAN) has no hub charge, but Azure took ~20
// minutes to provision it and ~15 minutes to delete it (measured; ≈$0 but
// ~35 minutes per run), well over the 10-minute budget.
lifecycle("Basic", !runExpensive);

// A Standard hub bills ~$0.25/hour and takes 15-30 minutes to provision its
// router (≈$0.25 per run, but well over the 10-minute budget).
lifecycle("Standard", !runExpensive);
