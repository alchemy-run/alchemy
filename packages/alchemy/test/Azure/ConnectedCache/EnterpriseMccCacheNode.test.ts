import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  getCacheNode,
  getCustomer,
  logLevel,
  tags,
  untilGone,
  untilSucceeded,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  name?: string;
  isEnabled?: boolean;
  maxAllowableEgressInMbps?: number;
  proxyUrl?: string;
  sizeInGb: number;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "westus",
    });
    // Enterprise MCC customers exist only in westus, northeurope, koreacentral.
    const customer = yield* Azure.ConnectedCache.EnterpriseMccCustomer(
      "Customer",
      { resourceGroup: group.resourceGroupName, location: "westus" },
    );
    const node = yield* Azure.ConnectedCache.EnterpriseMccCacheNode("Node", {
      resourceGroup: group.resourceGroupName,
      customer: customer.customerResourceName,
      name: props.name,
      osType: "Linux",
      driveConfiguration: [
        { physicalPath: "/var/mcc", sizeInGb: props.sizeInGb, cacheNumber: 1 },
      ],
      isEnabled: props.isEnabled,
      maxAllowableEgressInMbps: props.maxAllowableEgressInMbps,
      proxyUrl: props.proxyUrl,
      tags: props.tags,
    });
    return { group, customer, node };
  });

// Cost: the ARM customer and cache node records are free (no host server is
// provisioned). ~2-4 minutes.
test.provider(
  "create, update, replace, and delete a Connected Cache cache node",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const { group, customer, node } = yield* stack.deploy(
        program({ sizeInGb: 100, tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      const cust = customer.customerResourceName;
      expect(node.tags).toEqual({ env: "test" });
      expect(node.location.toLowerCase()).toEqual("westus");
      expect(node.cacheNodeId).toBeDefined();
      expect(node.isProvisioned).toEqual(false);
      const observed = yield* untilSucceeded(
        getCacheNode(rg, cust, node.cacheNodeResourceName),
      );
      expect(observed.properties?.cacheNode?.isEnabled).toEqual(false);
      expect(
        observed.properties?.additionalCacheNodeProperties?.osType,
      ).toEqual("Linux");
      expect(
        observed.properties?.additionalCacheNodeProperties
          ?.driveConfiguration?.[0]?.sizeInGb,
      ).toEqual(100);

      // In-place update: enable, cap egress, add a proxy, grow the drive.
      const updated = yield* stack.deploy(
        program({
          sizeInGb: 150,
          isEnabled: true,
          maxAllowableEgressInMbps: 500,
          proxyUrl: "http://proxy.example.com:8080",
          tags: { env: "prod" },
        }),
      );
      expect(updated.node.cacheNodeResourceName).toEqual(
        node.cacheNodeResourceName,
      );
      expect(updated.node.cacheNodeId).toEqual(node.cacheNodeId);
      expect(updated.node.tags).toEqual({ env: "prod" });
      const afterUpdate = yield* getCacheNode(
        rg,
        cust,
        node.cacheNodeResourceName,
      );
      expect(afterUpdate.properties?.cacheNode?.isEnabled).toEqual(true);
      expect(
        afterUpdate.properties?.cacheNode?.maxAllowableEgressInMbps,
      ).toEqual(500);
      expect(
        afterUpdate.properties?.additionalCacheNodeProperties
          ?.proxyUrlConfiguration?.proxyUrl,
      ).toEqual("http://proxy.example.com:8080");
      expect(
        afterUpdate.properties?.additionalCacheNodeProperties
          ?.driveConfiguration?.[0]?.sizeInGb,
      ).toEqual(150);

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-test-mcc-node-renamed",
          sizeInGb: 150,
          isEnabled: true,
          maxAllowableEgressInMbps: 500,
          tags: { env: "prod" },
        }),
      );
      expect(replaced.node.cacheNodeResourceName).toEqual(
        "alchemy-test-mcc-node-renamed",
      );
      expect(replaced.node.proxyUrl).toBeUndefined();
      expect(
        (yield* getCacheNode(rg, cust, "alchemy-test-mcc-node-renamed"))
          .properties?.cacheNode?.isEnabled,
      ).toEqual(true);
      expect(
        yield* untilGone(getCacheNode(rg, cust, node.cacheNodeResourceName)),
      ).toEqual("gone");

      // Delete.
      yield* stack.destroy();
      expect(
        yield* untilGone(
          getCacheNode(rg, cust, "alchemy-test-mcc-node-renamed"),
        ),
      ).toEqual("gone");
      expect(yield* untilGone(getCustomer(rg, cust))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
