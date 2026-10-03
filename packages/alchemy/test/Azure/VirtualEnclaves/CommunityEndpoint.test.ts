import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mission from "@distilled.cloud/azure/mission";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  community,
  LIFECYCLE_TIMEOUT,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getEndpoint = (
  resourceGroupName: string,
  communityName: string,
  communityEndpointName: string,
) =>
  Effect.gen(function* () {
    return yield* mission.GetCommunityEndpoint({
      subscriptionId: yield* subscription,
      resourceGroupName,
      communityName,
      communityEndpointName,
    });
  });

const program = (ports: string) =>
  Effect.gen(function* () {
    const { group, community: hub } = yield* community();
    const endpoint = yield* Azure.VirtualEnclaves.CommunityEndpoint("Egress", {
      resourceGroup: group.resourceGroupName,
      community: hub.communityName,
      ruleCollection: [
        {
          endpointRuleName: "microsoft",
          destination: "www.microsoft.com",
          destinationType: "FQDN",
          protocols: ["HTTPS"],
          ports,
        },
      ],
    });
    return { group, community: hub, endpoint };
  });

// Needs a community (vWAN hub + Basic firewall, ~$0.65/h, 30-60+ min):
// ~$1.5-3 and up to two hours per run. Run with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a community endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const {
        group,
        community: hub,
        endpoint,
      } = yield* stack.deploy(program("443"));
      const get = getEndpoint(
        group.resourceGroupName,
        hub.communityName,
        endpoint.communityEndpointName,
      );
      expect((yield* get).properties?.ruleCollection[0]?.ports).toEqual("443");

      // In-place: rule ports.
      const updated = yield* stack.deploy(program("8443"));
      expect(updated.endpoint.communityEndpointId).toEqual(
        endpoint.communityEndpointId,
      );
      expect((yield* get).properties?.ruleCollection[0]?.ports).toEqual("8443");

      yield* stack.destroy();
      expect(yield* waitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: LIFECYCLE_TIMEOUT },
);
