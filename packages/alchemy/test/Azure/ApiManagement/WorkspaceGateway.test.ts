import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getGateway = (resourceGroupName: string, gatewayName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetApiGateway({ subscriptionId, resourceGroupName, gatewayName }),
  );

const program = (gateway?: { team: string }) =>
  Effect.gen(function* () {
    // WorkspaceGatewayPremium is offered in a subset of regions (not eastus).
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "westus",
    });
    const created = gateway
      ? yield* Azure.ApiManagement.WorkspaceGateway("Gateway", {
          resourceGroup: group.resourceGroupName,
          location: "westus",
          sku: "WorkspaceGatewayPremium",
          capacity: 1,
          tags: { team: gateway.team },
        })
      : undefined;
    return { group, gateway: created };
  });

// A premium workspace gateway bills per scale unit (several $/h) and takes
// 30+ minutes to create: est. ~$3 and ~60-90 minutes per run.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a workspace gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program({ team: "payments" }));
      const rg = first.group.resourceGroupName;
      const name = first.gateway!.gatewayName;
      expect(first.gateway?.sku).toEqual("WorkspaceGatewayPremium");
      const observed = yield* getGateway(rg, name);
      expect(observed.tags?.team).toEqual("payments");

      // In-place update of the user tags.
      yield* stack.deploy(program({ team: "billing" }));
      expect((yield* getGateway(rg, name)).tags?.team).toEqual("billing");

      // Removing the resource deletes the gateway.
      yield* stack.deploy(program());
      expect(yield* untilGone(getGateway(rg, name))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 7_200_000 },
);
