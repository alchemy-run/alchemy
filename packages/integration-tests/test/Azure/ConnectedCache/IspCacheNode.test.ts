import * as Azure from "@alchemy.run/azure";
import { expect } from "alchemy-test";
import type { Input } from "alchemy/Input";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { getIspCacheNode, getIspCustomer, logLevel, tags, untilGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * ARM ID of an ISP customer whose signup has completed (its ASN verified
 * through PeeringDB). Signup needs a real ISP ASN, so the customer is
 * created outside the test.
 */
const signedUpCustomerId = process.env.AZURE_TEST_MCC_ISP_CUSTOMER_ID;
const signedUp = signedUpCustomerId?.match(
  /\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ConnectedCache\/ispCustomers\/([^/]+)$/i,
);

const nodeProgram = (props: {
  resourceGroup: Input<string>;
  customer: Input<string>;
  name?: string;
  isEnabled?: boolean;
  maxAllowableEgressInMbps: number;
  cidrCsv: string[];
  sizeInGb: number;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const node = yield* Azure.ConnectedCache.IspCacheNode("Node", {
      resourceGroup: props.resourceGroup,
      customer: props.customer,
      name: props.name,
      osType: "Linux",
      ipAddress: "203.0.113.10",
      cidrCsv: props.cidrCsv,
      maxAllowableEgressInMbps: props.maxAllowableEgressInMbps,
      isEnabled: props.isEnabled,
      driveConfiguration: [{ physicalPath: "/var/mcc", sizeInGb: props.sizeInGb, cacheNumber: 1 }],
      tags: props.tags,
    });
    return { node };
  });

// Needs an ISP customer with completed signup (external: a real ASN
// verified through PeeringDB), passed as AZURE_TEST_MCC_ISP_CUSTOMER_ID.
// ~$0/run (ARM records only, no host server), ~3-5 min.
test.provider.skipIf(!runPaidOnly || signedUp === null || signedUp === undefined)(
  "create, update, replace, and delete a Connected Cache ISP cache node",
  (stack) =>
    Effect.gen(function* () {
      const [, rg, cust] = signedUp!;
      yield* stack.destroy();

      // Create.
      const { node } = yield* stack.deploy(
        nodeProgram({
          resourceGroup: rg!,
          customer: cust!,
          maxAllowableEgressInMbps: 1000,
          cidrCsv: ["198.51.100.0/24"],
          sizeInGb: 100,
          tags: { env: "test" },
        }),
      );
      expect(node.tags).toEqual({ env: "test" });
      expect(node.cacheNodeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(node.isProvisioned).toEqual(false);
      const observed = yield* getIspCacheNode(rg!, cust!, node.cacheNodeResourceName);
      expect(observed.properties?.cacheNode?.ipAddress).toEqual("203.0.113.10");
      expect(observed.properties?.cacheNode?.cidrCsv).toEqual(["198.51.100.0/24"]);
      expect(observed.properties?.cacheNode?.isEnabled).toEqual(false);

      // In-place update: enable, raise the egress cap, change the ranges, grow the drive.
      const updated = yield* stack.deploy(
        nodeProgram({
          resourceGroup: rg!,
          customer: cust!,
          isEnabled: true,
          maxAllowableEgressInMbps: 2000,
          cidrCsv: ["198.51.100.0/24", "192.0.2.0/24"],
          sizeInGb: 200,
          tags: { env: "prod" },
        }),
      );
      expect(updated.node.cacheNodeId).toEqual(node.cacheNodeId);
      expect(updated.node.tags).toEqual({ env: "prod" });
      const afterUpdate = yield* getIspCacheNode(rg!, cust!, node.cacheNodeResourceName);
      expect(afterUpdate.properties?.cacheNode?.isEnabled).toEqual(true);
      expect(afterUpdate.properties?.cacheNode?.maxAllowableEgressInMbps).toEqual(2000);
      expect([...(afterUpdate.properties?.cacheNode?.cidrCsv ?? [])].sort()).toEqual([
        "192.0.2.0/24",
        "198.51.100.0/24",
      ]);
      expect(
        afterUpdate.properties?.additionalCacheNodeProperties?.driveConfiguration?.[0]?.sizeInGb,
      ).toEqual(200);

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(
        nodeProgram({
          resourceGroup: rg!,
          customer: cust!,
          name: "alchemy-test-mcc-isp-node-renamed",
          isEnabled: true,
          maxAllowableEgressInMbps: 2000,
          cidrCsv: ["198.51.100.0/24"],
          sizeInGb: 200,
          tags: { env: "prod" },
        }),
      );
      expect(replaced.node.cacheNodeResourceName).toEqual("alchemy-test-mcc-isp-node-renamed");
      const oldGone = yield* untilGone(getIspCacheNode(rg!, cust!, node.cacheNodeResourceName));
      expect(oldGone).toEqual("gone");

      // Delete.
      yield* stack.destroy();
      const renamedGone = yield* untilGone(
        getIspCacheNode(rg!, cust!, "alchemy-test-mcc-isp-node-renamed"),
      );
      expect(renamedGone).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: a fresh ISP customer has not completed signup, so the
// cache node create fails with the typed signup error. ~$0/run, ~1-2 min.
test.provider(
  "ISP cache nodes are rejected until the customer signup completes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const base = Effect.gen(function* () {
        const group = yield* Azure.Resources.ResourceGroup("Group", { location: "westus" });
        const customer = yield* Azure.ConnectedCache.IspCustomer("Customer", {
          resourceGroup: group.resourceGroupName,
          location: "westus",
        });
        return { group, customer };
      });
      const { group: rg, customer } = yield* stack.deploy(base);
      expect(customer.signupStatus).toEqual(false);

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            const { group, customer } = yield* base;
            const { node } = yield* nodeProgram({
              resourceGroup: group.resourceGroupName,
              customer: customer.customerResourceName,
              maxAllowableEgressInMbps: 1000,
              cidrCsv: ["198.51.100.0/24"],
              sizeInGb: 100,
              tags: {},
            });
            return { node };
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("ConnectedCacheIspSignupIncomplete");

      yield* stack.destroy();
      const customerGone = yield* untilGone(
        getIspCustomer(rg.resourceGroupName, customer.customerResourceName),
      );
      expect(customerGone).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
