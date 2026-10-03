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

const getEnclave = (resourceGroupName: string, virtualEnclaveName: string) =>
  Effect.gen(function* () {
    return yield* mission.GetVirtualEnclave({
      subscriptionId: yield* subscription,
      resourceGroupName,
      virtualEnclaveName,
    });
  });

const program = (props: {
  allowSubnetCommunication: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, community: hub } = yield* community();
    const enclave = yield* Azure.VirtualEnclaves.VirtualEnclave("Enclave", {
      resourceGroup: group.resourceGroupName,
      communityId: hub.communityId,
      enclaveVirtualNetwork: {
        networkSize: "small",
        subnetConfigurations: [{ subnetName: "apps", networkPrefixSize: 26 }],
        allowSubnetCommunication: props.allowSubnetCommunication,
      },
      tags: props.tags,
    });
    return { group, community: hub, enclave };
  });

// Needs a community (vWAN hub + Basic firewall, ~$0.65/h, 30-60+ min) plus
// a 20-40 min enclave deployment: ~$2-4 and up to three hours per run.
// Run with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a virtual enclave",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const {
        group,
        community: hub,
        enclave,
      } = yield* stack.deploy(
        program({ allowSubnetCommunication: false, tags: { env: "test" } }),
      );
      expect(enclave.communityId.toLowerCase()).toEqual(
        hub.communityId.toLowerCase(),
      );
      expect(enclave.subnets.map((s) => s.subnetName)).toContain("apps");
      const observed = yield* getEnclave(
        group.resourceGroupName,
        enclave.virtualEnclaveName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      // In-place: subnet communication and tags.
      const updated = yield* stack.deploy(
        program({ allowSubnetCommunication: true, tags: { env: "prod" } }),
      );
      expect(updated.enclave.virtualEnclaveId).toEqual(
        enclave.virtualEnclaveId,
      );
      const after = yield* getEnclave(
        group.resourceGroupName,
        enclave.virtualEnclaveName,
      );
      expect(
        after.properties?.enclaveVirtualNetwork.allowSubnetCommunication,
      ).toEqual(true);
      expect(after.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getEnclave(group.resourceGroupName, enclave.virtualEnclaveName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: LIFECYCLE_TIMEOUT },
);
