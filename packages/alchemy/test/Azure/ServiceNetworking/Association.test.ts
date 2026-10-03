import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as servicenetworking from "@distilled.cloud/azure/servicenetworking";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscription, tags, untilGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const AGC_DELEGATION = [
  { serviceName: "Microsoft.ServiceNetworking/trafficControllers" },
];

// Both delegated subnets stay deployed across the replacement step.
const network = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
    resourceGroup: group.resourceGroupName,
    addressPrefixes: ["10.60.0.0/16"],
  });
  const subnetA = yield* Azure.Network.Subnet("SubnetA", {
    resourceGroup: group.resourceGroupName,
    virtualNetwork: vnet.virtualNetworkName,
    addressPrefix: "10.60.1.0/24",
    delegations: AGC_DELEGATION,
  });
  const subnetB = yield* Azure.Network.Subnet("SubnetB", {
    resourceGroup: group.resourceGroupName,
    virtualNetwork: vnet.virtualNetworkName,
    addressPrefix: "10.60.2.0/24",
    delegations: AGC_DELEGATION,
  });
  const controller = yield* Azure.ServiceNetworking.TrafficController(
    "Controller",
    { resourceGroup: group.resourceGroupName },
  );
  return { group, vnet, subnetA, subnetB, controller };
});

const withAssociation = (props: {
  subnet: "A" | "B";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const base = yield* network;
    const association = yield* Azure.ServiceNetworking.Association(
      "Association",
      {
        resourceGroup: base.group.resourceGroupName,
        trafficController: base.controller.trafficControllerName,
        subnetId:
          props.subnet === "A" ? base.subnetA.subnetId : base.subnetB.subnetId,
        tags: props.tags,
      },
    );
    return { ...base, association };
  });

const getAssociation = (
  resourceGroupName: string,
  trafficControllerName: string,
  associationName: string,
) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    servicenetworking.GetAssociationsInterface({
      subscriptionId,
      resourceGroupName,
      trafficControllerName,
      associationName,
    }),
  );

// Cost: association (~$0.12/hour) + traffic controller (~$0.017/hour) for
// ~20-30 minutes across two association generations (< $0.15). Subnet
// injection and removal each take ~5-10 minutes, so the whole lifecycle
// runs ~25-40 minutes: gated as expensive (slow).
test.provider.skipIf(!runExpensive)(
  "create, update tags, replace, and delete an AGC association",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const { group, controller, subnetA, subnetB, association } =
        yield* stack.deploy(
          withAssociation({ subnet: "A", tags: { env: "test" } }),
        );
      const rg = group.resourceGroupName;
      const tc = controller.trafficControllerName;
      expect(association.associationType).toEqual("subnets");
      expect(association.subnetId?.toLowerCase()).toEqual(
        subnetA.subnetId.toLowerCase(),
      );
      const observed = yield* getAssociation(
        rg,
        tc,
        association.associationName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.["alchemy::id"]).toEqual("Association");

      // In-place update: tags.
      const updated = yield* stack.deploy(
        withAssociation({ subnet: "A", tags: { env: "prod" } }),
      );
      expect(updated.association.associationName).toEqual(
        association.associationName,
      );
      expect(
        (yield* getAssociation(rg, tc, association.associationName)).tags?.env,
      ).toEqual("prod");

      // Replacement: a different subnet (delete-first: one association per
      // traffic controller).
      const replaced = yield* stack.deploy(
        withAssociation({ subnet: "B", tags: { env: "prod" } }),
      );
      expect(replaced.association.subnetId?.toLowerCase()).toEqual(
        subnetB.subnetId.toLowerCase(),
      );
      expect(
        (yield* getAssociation(
          rg,
          tc,
          replaced.association.associationName,
        )).properties?.subnet?.id.toLowerCase(),
      ).toEqual(subnetB.subnetId.toLowerCase());

      // Delete the association, keep the network and controller.
      yield* stack.deploy(network);
      expect(
        yield* untilGone(
          getAssociation(rg, tc, replaced.association.associationName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
