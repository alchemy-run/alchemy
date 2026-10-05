import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";
import { basicV2Service, logLevel, subscriptionId, tags } from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const members = (resourceGroupName: string, serviceName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.ListProductGroupByProduct({
      subscriptionId,
      resourceGroupName,
      serviceName,
      productId: "alchemy-premium",
    }),
  ).pipe(
    // New products also grant the built-in administrators group access.
    Effect.map((page) =>
      (page.value ?? [])
        .map((g) => g.name ?? "")
        .filter((name) => name.startsWith("alchemy-")),
    ),
  );

/** Poll until the product's groups match `expected` (bounded). */
const untilMembers = (
  resourceGroupName: string,
  serviceName: string,
  expected: string[],
) =>
  members(resourceGroupName, serviceName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (names) => names.sort().join(",") === expected.sort().join(","),
      times: 10,
    }),
  );

const program = (member?: "partners" | "vendors") =>
  Effect.gen(function* () {
    const { group, service } = yield* basicV2Service;
    const product = yield* Azure.ApiManagement.Product("Premium", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-premium",
      displayName: "Premium",
    });
    // Both groups stay deployed across the replacement step.
    const partners = yield* Azure.ApiManagement.Group("Partners", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-partners",
      displayName: "Partners",
    });
    const vendors = yield* Azure.ApiManagement.Group("Vendors", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-vendors",
      displayName: "Vendors",
    });
    const membership = member
      ? yield* Azure.ApiManagement.ProductGroup("Access", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          productName: product.productName,
          groupName:
            member === "partners" ? partners.groupName : vendors.groupName,
        })
      : undefined;
    return { group, service, membership };
  });

// Groups are not available on Consumption ("Method not allowed
// in Consumption pricing tier"). A BasicV2 service bills ~$0.21/h and
// takes 5-15+ minutes to create: est. ~$0.10 and ~25 minutes per run.
test.provider.skipIf(!runExpensive)(
  "grant, replace, and revoke group access to a product",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("partners"));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.membership?.groupName).toEqual("alchemy-partners");
      expect(yield* untilMembers(rg, svc, ["alchemy-partners"])).toEqual([
        "alchemy-partners",
      ]);

      // Replacement: another group gets access, the old one loses it.
      yield* stack.deploy(program("vendors"));
      expect(yield* untilMembers(rg, svc, ["alchemy-vendors"])).toEqual([
        "alchemy-vendors",
      ]);

      // Removing the resource revokes the access.
      yield* stack.deploy(program());
      expect(yield* untilMembers(rg, svc, [])).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
