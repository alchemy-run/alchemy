import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

/** Built-in "Azure AI Enterprise Network Connection Approver" role. */
const NETWORK_CONNECTION_APPROVER = "b556d68e-0be0-4f35-a333-ad7ee1ce17ea";

const program = (props: {
  name: string;
  subresourceTarget: "blob" | "queue";
}) =>
  Effect.gen(function* () {
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
    const network = yield* Azure.CognitiveServices.ManagedNetwork("Network", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      isolationMode: "AllowInternetOutbound",
    });
    const storage = yield* Azure.Storage.StorageAccount("Files", {
      resourceGroup: group.resourceGroupName,
    });
    // The account's identity approves the private endpoint on the target.
    const approver = yield* Azure.Authorization.RoleAssignment("Approver", {
      scope: storage.storageAccountId,
      roleDefinitionId: NETWORK_CONNECTION_APPROVER,
      principalId: account.principalId.as<string>(),
      principalType: "ServicePrincipal",
    });
    const rule = yield* Azure.CognitiveServices.OutboundRule("Rule", {
      resourceGroup: group.resourceGroupName,
      account: network.account,
      name: props.name,
      type: "PrivateEndpoint",
      destination: {
        // Create the rule only after the approver grant exists.
        serviceResourceId: Output.all(
          storage.storageAccountId,
          approver.roleAssignmentId,
        ).pipe(Output.map(([storageAccountId]) => storageAccountId)),
        subresourceTarget: props.subresourceTarget,
      },
    });
    return { group, account, rule };
  });

// Needs the managed VNet (~5-10 minutes to create, ~30 minutes to delete
// with the account, preview) plus a managed private endpoint
// (~$0.01/hour): gated as slow.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a managed network outbound rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;

      const { group, account } = yield* stack.deploy(
        program({ name: "alchemy-rule-a", subresourceTarget: "blob" }),
      );
      const get = (ruleName: string) =>
        cognitiveservices.GetOutboundRule({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          accountName: account.accountName,
          managedNetworkName: "default",
          ruleName,
        });
      const observed = yield* get("alchemy-rule-a");
      expect(observed.properties.type).toEqual("PrivateEndpoint");
      expect(observed.properties.destination).toMatchObject({
        subresourceTarget: "blob",
      });

      // Rules are immutable: a different sub-resource replaces the rule
      // under the same name (delete first).
      yield* stack.deploy(
        program({ name: "alchemy-rule-a", subresourceTarget: "queue" }),
      );
      expect(
        (yield* get("alchemy-rule-a")).properties.destination,
      ).toMatchObject({ subresourceTarget: "queue" });

      // Replacement: the name is immutable.
      yield* stack.deploy(
        program({ name: "alchemy-rule-b", subresourceTarget: "queue" }),
      );
      expect((yield* get("alchemy-rule-b")).properties.type).toEqual(
        "PrivateEndpoint",
      );
      expect(yield* waitGone(get("alchemy-rule-a"))).toEqual("gone");

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
  { tags, timeout: 5_400_000 },
);
