import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cdn from "@distilled.cloud/azure/cdn";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  FRONT_DOOR_TIMEOUT,
  logLevel,
  profileStack,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getOrigin = (
  resourceGroupName: string,
  profileName: string,
  originGroupName: string,
  originName: string,
) =>
  Effect.gen(function* () {
    return yield* cdn.GetAFDOrigin({
      subscriptionId: yield* subscription,
      resourceGroupName,
      profileName,
      originGroupName,
      originName,
    });
  });

const program = (props: { name?: string; weight: number; priority: number }) =>
  Effect.gen(function* () {
    const { group, profile } = yield* profileStack;
    const originGroup = yield* Azure.Cdn.AfdOriginGroup("Origins", {
      resourceGroup: group.resourceGroupName,
      profile: profile.profileName,
    });
    const origin = yield* Azure.Cdn.AfdOrigin("Origin", {
      resourceGroup: group.resourceGroupName,
      profile: profile.profileName,
      originGroup: originGroup.originGroupName,
      name: props.name,
      hostName: "www.bing.com",
      weight: props.weight,
      priority: props.priority,
    });
    return { group, profile, originGroup, origin };
  });

// Front Door Standard profile (<$0.10 per run, 10-20 minutes with the profile
// delete). Free Trial subscriptions cannot create Front Door profiles.
test.provider.skipIf(!runPaidOnly)(
  "origin lifecycle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, profile, originGroup, origin } = yield* stack.deploy(
        program({ weight: 1000, priority: 1 }),
      );
      const get = (name: string) =>
        getOrigin(
          group.resourceGroupName,
          profile.profileName,
          originGroup.originGroupName,
          name,
        );
      const observed = yield* get(origin.originName);
      expect(observed.properties?.hostName).toEqual("www.bing.com");
      expect(observed.properties?.originHostHeader).toEqual("www.bing.com");
      expect(observed.properties?.weight).toEqual(1000);

      // In place: weight and priority.
      const updated = yield* stack.deploy(
        program({ weight: 500, priority: 2 }),
      );
      expect(updated.origin.originId).toEqual(origin.originId);
      const reobserved = yield* get(origin.originName);
      expect(reobserved.properties?.weight).toEqual(500);
      expect(reobserved.properties?.priority).toEqual(2);

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-origin-renamed", weight: 500, priority: 2 }),
      );
      expect(replaced.origin.originName).toEqual("alchemy-origin-renamed");
      expect(yield* waitGone(get(origin.originName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.origin.originName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: FRONT_DOOR_TIMEOUT },
);
