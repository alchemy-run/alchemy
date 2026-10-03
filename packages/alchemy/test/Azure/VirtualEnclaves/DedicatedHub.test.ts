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

const getHub = (
  resourceGroupName: string,
  communityName: string,
  dedicatedHubName: string,
) =>
  Effect.gen(function* () {
    return yield* mission.GetDedicatedHub({
      subscriptionId: yield* subscription,
      resourceGroupName,
      communityName,
      dedicatedHubName,
    });
  });

const program = (hubTags: Record<string, string>) =>
  Effect.gen(function* () {
    const { group, community: hub } = yield* community();
    const dedicated = yield* Azure.VirtualEnclaves.DedicatedHub("Dedicated", {
      resourceGroup: group.resourceGroupName,
      community: hub.communityName,
      designation: "Reserved",
      tags: hubTags,
    });
    return { group, community: hub, dedicated };
  });

// A community plus a second vWAN hub and firewall (~$1.3/h together, each
// 30-60+ min): ~$3-5 and up to three hours per run. Run with
// AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a dedicated hub",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const {
        group,
        community: hub,
        dedicated,
      } = yield* stack.deploy(program({ env: "test" }));
      expect(dedicated.vHubResourceId).toBeDefined();
      const get = getHub(
        group.resourceGroupName,
        hub.communityName,
        dedicated.dedicatedHubName,
      );
      const observed = yield* get;
      expect(observed.properties?.designation).toEqual("Reserved");
      expect(observed.tags?.env).toEqual("test");

      // In-place: tags.
      const updated = yield* stack.deploy(program({ env: "prod" }));
      expect(updated.dedicated.dedicatedHubId).toEqual(
        dedicated.dedicatedHubId,
      );
      expect((yield* get).tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* waitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: LIFECYCLE_TIMEOUT },
);
