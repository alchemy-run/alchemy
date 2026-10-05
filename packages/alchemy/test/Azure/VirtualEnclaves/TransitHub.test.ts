import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as mission from "@distilled.cloud/azure/mission";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  community,
  enclave,
  LIFECYCLE_TIMEOUT,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getTransitHub = (
  resourceGroupName: string,
  communityName: string,
  transitHubName: string,
) =>
  Effect.gen(function* () {
    return yield* mission.GetTransitHub({
      subscriptionId: yield* subscription,
      resourceGroupName,
      communityName,
      transitHubName,
    });
  });

const program = (hubTags: Record<string, string>) =>
  Effect.gen(function* () {
    const { group, community: hub } = yield* community();
    // Azure rejects a transit hub until the community has a vHub, which
    // the first enclave deploys.
    const spoke = yield* enclave(
      "Spoke",
      group.resourceGroupName,
      hub.communityId,
    );
    const transit = yield* Azure.VirtualEnclaves.TransitHub("Transit", {
      resourceGroup: group.resourceGroupName,
      // Create the transit hub only after the enclave exists.
      community: Output.all(hub.communityName, spoke.virtualEnclaveId).pipe(
        Output.map(([communityName]) => communityName),
      ),
      // A `Peering` transit hub to a VNet in the same resource group ends
      // in provisioningState `Failed` with no error detail; a one-unit VPN
      // gateway needs no external network.
      transitOption: { type: "Gateway", scaleUnits: 1 },
      tags: hubTags,
    });
    return { group, community: hub, transit };
  });

// Needs a community (vWAN hub + firewall, 30-60+ min), an enclave (which
// deploys the community vHub, ~60-90 min) and a VPN transit hub: ~$3-6
// and up to three hours per run. Run with
// AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a transit hub",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const {
        group,
        community: hub,
        transit,
      } = yield* stack.deploy(program({ env: "test" }));
      const get = getTransitHub(
        group.resourceGroupName,
        hub.communityName,
        transit.transitHubName,
      );
      const observed = yield* get;
      expect(observed.properties?.transitOption?.type).toEqual("Gateway");
      expect(observed.tags?.env).toEqual("test");

      // In-place: tags.
      const updated = yield* stack.deploy(program({ env: "prod" }));
      expect(updated.transit.transitHubId).toEqual(transit.transitHubId);
      expect((yield* get).tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* waitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: LIFECYCLE_TIMEOUT },
);
