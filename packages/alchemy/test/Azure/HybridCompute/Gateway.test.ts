import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hybridcompute from "@distilled.cloud/azure/hybridcompute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getGateway = (resourceGroupName: string, gatewayName: string) =>
  Effect.gen(function* () {
    return yield* hybridcompute.GetGateway({
      subscriptionId: yield* subscription,
      resourceGroupName,
      gatewayName,
    });
  });

const program = (props: {
  gatewayBypass?: string[];
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const gateway = yield* Azure.HybridCompute.Gateway("Gateway", {
      resourceGroup: group.resourceGroupName,
      ...props,
    });
    return { group, gateway };
  });

// Free, but provisioning took ~24 minutes on the test subscription (and
// writes are rejected until it settles), so the lifecycle runs only with
// AZURE_TEST_EXPENSIVE=1 and needs a longer timeout than the usual cap.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete an Arc gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, gateway } = yield* stack.deploy(program({}));
      const rg = group.resourceGroupName;
      expect(gateway.gatewayEndpoint).toMatch(/\.gw\.arc\.azure\.com$/);
      expect(gateway.allowedFeatures).toEqual(["*"]);
      const observed = yield* getGateway(rg, gateway.gatewayName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.["alchemy::id"]).toEqual("Gateway");

      // In-place: bypass list and a tag.
      const updated = yield* stack.deploy(
        program({
          gatewayBypass: ["packages.example.com"],
          tags: { env: "test" },
        }),
      );
      expect(updated.gateway.gatewayId).toEqual(gateway.gatewayId);
      const reobserved = yield* getGateway(rg, gateway.gatewayName);
      expect(reobserved.properties?.gatewayBypass).toEqual([
        "packages.example.com",
      ]);
      expect(reobserved.tags?.env).toEqual("test");

      yield* stack.destroy();
      expect(yield* waitGone(getGateway(rg, gateway.gatewayName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 3_000_000 },
);
