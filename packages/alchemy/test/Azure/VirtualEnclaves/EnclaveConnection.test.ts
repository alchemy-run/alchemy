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

const getConnection = (
  resourceGroupName: string,
  enclaveConnectionName: string,
) =>
  Effect.gen(function* () {
    return yield* mission.GetEnclaveConnection({
      subscriptionId: yield* subscription,
      resourceGroupName,
      enclaveConnectionName,
    });
  });

const program = (connectionTags: Record<string, string>) =>
  Effect.gen(function* () {
    const { group, community: hub } = yield* community();
    const source = yield* enclave(
      "Source",
      group.resourceGroupName,
      hub.communityId,
    );
    const target = yield* enclave(
      "Target",
      group.resourceGroupName,
      hub.communityId,
    );
    const endpoint = yield* Azure.VirtualEnclaves.EnclaveEndpoint("Ingress", {
      resourceGroup: group.resourceGroupName,
      virtualEnclave: target.virtualEnclaveName,
      ruleCollection: [
        {
          endpointRuleName: "https",
          destination: Output.map(
            target.subnets,
            (subnets) => subnets[0]?.addressPrefix ?? "",
          ),
          protocols: ["TCP"],
          ports: "443",
        },
      ],
    });
    const connection = yield* Azure.VirtualEnclaves.EnclaveConnection(
      "Connection",
      {
        resourceGroup: group.resourceGroupName,
        communityId: hub.communityId,
        sourceId: source.virtualEnclaveId,
        destinationEndpointId: endpoint.enclaveEndpointId,
        tags: connectionTags,
      },
    );
    return { group, connection };
  });

// Needs a community (vWAN hub + Basic firewall, ~$0.65/h, 30-60+ min) and
// two enclaves (20-40 min each): ~$3-5 and up to three hours per run. Run
// with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete an enclave connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, connection } = yield* stack.deploy(
        program({ env: "test" }),
      );
      expect(connection.state).toBeDefined();
      const get = getConnection(
        group.resourceGroupName,
        connection.enclaveConnectionName,
      );
      expect((yield* get).tags?.env).toEqual("test");

      // In-place: tags.
      const updated = yield* stack.deploy(program({ env: "prod" }));
      expect(updated.connection.enclaveConnectionId).toEqual(
        connection.enclaveConnectionId,
      );
      expect((yield* get).tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* waitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: LIFECYCLE_TIMEOUT },
);
