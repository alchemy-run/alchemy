import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { name: string; description: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.CognitiveServices.Account("Foundry", {
      resourceGroup: group.resourceGroupName,
      allowProjectManagement: true,
      identity: { type: "SystemAssigned" },
    });
    const host = yield* Azure.CognitiveServices.CapabilityHost("Agents", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      name: props.name,
      description: props.description,
    });
    return { group, account, host };
  });

// Basic agent setup (Microsoft-managed storage) on an S0 Foundry account:
// $0 idle, ~1-2 minutes.
test.provider(
  "create, replace, and delete an account capability host",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;

      const { group, account, host } = yield* stack.deploy(
        program({ name: "alchemy-host-a", description: "first" }),
      );
      const get = (capabilityHostName: string) =>
        cognitiveservices.GetAccountCapabilityHost({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          accountName: account.accountName,
          capabilityHostName,
        });
      expect(host.capabilityHostKind).toEqual("Agents");
      const observed = yield* get("alchemy-host-a");
      expect(observed.properties.provisioningState).toEqual("Succeeded");

      // Capability hosts are immutable: a changed description replaces it
      // (Azure allows one capability host per account, so the replacement
      // deletes the old host first).
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-host-a", description: "second" }),
      );
      expect(replaced.host.capabilityHostName).toEqual("alchemy-host-a");
      // Azure does not echo the description; the recreated host has a new
      // creation time.
      const recreated = yield* get("alchemy-host-a");
      expect(recreated.properties.provisioningState).toEqual("Succeeded");
      expect(recreated.systemData?.createdAt).not.toEqual(
        observed.systemData?.createdAt,
      );

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-host-a"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
