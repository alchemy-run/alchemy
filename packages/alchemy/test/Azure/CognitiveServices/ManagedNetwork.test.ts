import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const isolatedFoundry = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const account = yield* Azure.CognitiveServices.Account("Foundry", {
    resourceGroup: group.resourceGroupName,
    allowProjectManagement: true,
    identity: { type: "SystemAssigned" },
    networkInjections: [
      { scenario: "agent", useMicrosoftManagedNetwork: true },
    ],
  });
  return { group, account };
});

const program = (
  isolationMode: "AllowInternetOutbound" | "AllowOnlyApprovedOutbound",
) =>
  Effect.gen(function* () {
    const { group, account } = yield* isolatedFoundry;
    const network = yield* Azure.CognitiveServices.ManagedNetwork("Network", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      isolationMode,
    });
    return { group, account, network };
  });

// The managed VNet (preview) provisions for 10+ minutes, and tightening to
// AllowOnlyApprovedOutbound deploys an Azure Firewall (~$1.25/hour): gated.
test.provider.skipIf(!runExpensive)(
  "create, tighten, and delete a foundry managed network",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;

      const { group, account, network } = yield* stack.deploy(
        program("AllowInternetOutbound"),
      );
      const get = () =>
        cognitiveservices.GetManagedNetworkSettings({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          accountName: account.accountName,
          managedNetworkName: "default",
        });
      expect(network.isolationMode).toEqual("AllowInternetOutbound");
      expect((yield* get()).properties?.managedNetwork?.isolationMode).toEqual(
        "AllowInternetOutbound",
      );

      // In place: isolation can only be tightened.
      yield* stack.deploy(program("AllowOnlyApprovedOutbound"));
      expect((yield* get()).properties?.managedNetwork?.isolationMode).toEqual(
        "AllowOnlyApprovedOutbound",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(
          cognitiveservices.GetAccount({
            subscriptionId,
            resourceGroupName: group.resourceGroupName,
            accountName: account.accountName,
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
