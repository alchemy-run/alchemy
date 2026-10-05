import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPerimeter = (
  resourceGroupName: string,
  networkSecurityPerimeterName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNetworkSecurityPerimeter({
      subscriptionId,
      resourceGroupName,
      networkSecurityPerimeterName,
    }),
  );

const getLink = (
  resourceGroupName: string,
  networkSecurityPerimeterName: string,
  linkName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNetworkSecurityPerimeterLink({
      subscriptionId,
      resourceGroupName,
      networkSecurityPerimeterName,
      linkName,
    }),
  );

// Perimeters and links are free.
const program = (scoped: boolean) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const local = yield* Azure.Network.NetworkSecurityPerimeter("Local", {
      resourceGroup: group.resourceGroupName,
    });
    const remote = yield* Azure.Network.NetworkSecurityPerimeter("Remote", {
      resourceGroup: group.resourceGroupName,
    });
    const profile = yield* Azure.Network.NetworkSecurityPerimeterProfile(
      "Profile",
      {
        resourceGroup: group.resourceGroupName,
        networkSecurityPerimeter: local.networkSecurityPerimeterName,
      },
    );
    const link = yield* Azure.Network.NetworkSecurityPerimeterLink("Link", {
      resourceGroup: group.resourceGroupName,
      networkSecurityPerimeter: local.networkSecurityPerimeterName,
      remotePerimeterId: remote.networkSecurityPerimeterId,
      localInboundProfiles: scoped ? [profile.profileName] : ["*"],
    });
    return { group, local, remote, link };
  });

test.provider(
  "create, update, and delete a perimeter link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, local, link } = yield* stack.deploy(program(false));
      expect(link.status).toEqual("Approved");

      const updated = yield* stack.deploy(program(true));
      expect(updated.link.linkId).toEqual(link.linkId);
      const observed = yield* getLink(
        group.resourceGroupName,
        local.networkSecurityPerimeterName,
        link.linkName,
      );
      expect(observed.properties?.localInboundProfiles?.length).toEqual(1);
      expect(observed.properties?.localInboundProfiles?.[0]).not.toEqual("*");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getLink(
            group.resourceGroupName,
            local.networkSecurityPerimeterName,
            link.linkName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
