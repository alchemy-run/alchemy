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

const getEndpoint = (
  resourceGroupName: string,
  virtualEnclaveName: string,
  enclaveEndpointName: string,
) =>
  Effect.gen(function* () {
    return yield* mission.GetEnclaveEndpoint({
      subscriptionId: yield* subscription,
      resourceGroupName,
      virtualEnclaveName,
      enclaveEndpointName,
    });
  });

const program = (ports: string) =>
  Effect.gen(function* () {
    const { group, community: hub } = yield* community();
    const spoke = yield* enclave(
      "Enclave",
      group.resourceGroupName,
      hub.communityId,
    );
    const endpoint = yield* Azure.VirtualEnclaves.EnclaveEndpoint("Ingress", {
      resourceGroup: group.resourceGroupName,
      virtualEnclave: spoke.virtualEnclaveName,
      ruleCollection: [
        {
          endpointRuleName: "https",
          destination: Output.map(
            spoke.subnets,
            (subnets) => subnets[0]?.addressPrefix ?? "",
          ),
          protocols: ["TCP"],
          ports,
        },
      ],
    });
    return { group, enclave: spoke, endpoint };
  });

// Needs a community (vWAN hub + Basic firewall, ~$0.65/h, 30-60+ min) and
// an enclave (20-40 min): ~$2-4 and up to three hours per run. Run with
// AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete an enclave endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const {
        group,
        enclave: spoke,
        endpoint,
      } = yield* stack.deploy(program("443"));
      const get = getEndpoint(
        group.resourceGroupName,
        spoke.virtualEnclaveName,
        endpoint.enclaveEndpointName,
      );
      expect((yield* get).properties?.ruleCollection[0]?.ports).toEqual("443");

      // In-place: rule ports.
      const updated = yield* stack.deploy(program("8443"));
      expect(updated.endpoint.enclaveEndpointId).toEqual(
        endpoint.enclaveEndpointId,
      );
      expect((yield* get).properties?.ruleCollection[0]?.ports).toEqual("8443");

      yield* stack.destroy();
      expect(yield* waitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: LIFECYCLE_TIMEOUT },
);
