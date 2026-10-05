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

const getOriginGroup = (
  resourceGroupName: string,
  profileName: string,
  originGroupName: string,
) =>
  Effect.gen(function* () {
    return yield* cdn.GetAFDOriginGroup({
      subscriptionId: yield* subscription,
      resourceGroupName,
      profileName,
      originGroupName,
    });
  });

const program = (props: {
  name?: string;
  probePath: string;
  sampleSize: number;
}) =>
  Effect.gen(function* () {
    const { group, profile } = yield* profileStack;
    const originGroup = yield* Azure.Cdn.AfdOriginGroup("Origins", {
      resourceGroup: group.resourceGroupName,
      profile: profile.profileName,
      name: props.name,
      loadBalancingSettings: {
        sampleSize: props.sampleSize,
        successfulSamplesRequired: 2,
        additionalLatencyInMilliseconds: 50,
      },
      healthProbeSettings: {
        probePath: props.probePath,
        probeProtocol: "Https",
        probeRequestType: "HEAD",
        probeIntervalInSeconds: 100,
      },
    });
    return { group, profile, originGroup };
  });

// Front Door Standard profile (<$0.10 per run, 10-20 minutes with the profile
// delete). Free Trial subscriptions cannot create Front Door profiles.
test.provider.skipIf(!runPaidOnly)(
  "lifecycle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, profile, originGroup } = yield* stack.deploy(
        program({ probePath: "/", sampleSize: 4 }),
      );
      const get = (name: string) =>
        getOriginGroup(group.resourceGroupName, profile.profileName, name);
      const observed = yield* get(originGroup.originGroupName);
      expect(observed.properties?.healthProbeSettings?.probePath).toEqual("/");
      expect(observed.properties?.loadBalancingSettings?.sampleSize).toEqual(4);

      // In place: probe path and sample size.
      const updated = yield* stack.deploy(
        program({ probePath: "/health", sampleSize: 3 }),
      );
      expect(updated.originGroup.originGroupId).toEqual(
        originGroup.originGroupId,
      );
      const reobserved = yield* get(originGroup.originGroupName);
      expect(reobserved.properties?.healthProbeSettings?.probePath).toEqual(
        "/health",
      );
      expect(reobserved.properties?.loadBalancingSettings?.sampleSize).toEqual(
        3,
      );

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-origins-renamed",
          probePath: "/health",
          sampleSize: 3,
        }),
      );
      expect(replaced.originGroup.originGroupName).toEqual(
        "alchemy-origins-renamed",
      );
      expect(yield* waitGone(get(originGroup.originGroupName))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.originGroup.originGroupName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: FRONT_DOOR_TIMEOUT },
);
