import * as Azure from "@/Azure";
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

const getWorkload = (
  resourceGroupName: string,
  virtualEnclaveName: string,
  workloadName: string,
) =>
  Effect.gen(function* () {
    return yield* mission.GetWorkload({
      subscriptionId: yield* subscription,
      resourceGroupName,
      virtualEnclaveName,
      workloadName,
    });
  });

const program = (workloadTags: Record<string, string>) =>
  Effect.gen(function* () {
    const { group, community: hub } = yield* community();
    const spoke = yield* enclave(
      "Enclave",
      group.resourceGroupName,
      hub.communityId,
    );
    const workload = yield* Azure.VirtualEnclaves.Workload("Workload", {
      resourceGroup: group.resourceGroupName,
      virtualEnclave: spoke.virtualEnclaveName,
      tags: workloadTags,
    });
    return { group, enclave: spoke, workload };
  });

// Needs a community (vWAN hub + Basic firewall, ~$0.65/h, 30-60+ min) and
// an enclave (20-40 min): ~$2-4 and up to three hours per run. Run with
// AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a virtual enclave workload",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const {
        group,
        enclave: spoke,
        workload,
      } = yield* stack.deploy(program({ env: "test" }));
      expect(workload.provisioningState).toEqual("Succeeded");
      const get = getWorkload(
        group.resourceGroupName,
        spoke.virtualEnclaveName,
        workload.workloadName,
      );
      expect((yield* get).tags?.env).toEqual("test");

      // In-place: tags.
      const updated = yield* stack.deploy(program({ env: "prod" }));
      expect(updated.workload.workloadId).toEqual(workload.workloadId);
      expect((yield* get).tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* waitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: LIFECYCLE_TIMEOUT },
);
