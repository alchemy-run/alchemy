import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  gatewayName: string,
  configConnectionName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetApiGatewayConfigConnection({
      subscriptionId,
      resourceGroupName,
      gatewayName,
      configConnectionName,
    }),
  );

const program = (hostnames?: string[]) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Workspace gateways connect to workspaces of a Premium service.
    const service = yield* Azure.ApiManagement.Service("Premium", {
      resourceGroup: group.resourceGroupName,
      sku: { name: "Premium", capacity: 1 },
      publisherEmail: "ops@example.com",
      publisherName: "Alchemy",
    });
    const workspace = yield* Azure.ApiManagement.Workspace("Team", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-ws",
    });
    const gateway = yield* Azure.ApiManagement.WorkspaceGateway("Gateway", {
      resourceGroup: group.resourceGroupName,
    });
    const connection =
      hostnames === undefined
        ? undefined
        : yield* Azure.ApiManagement.WorkspaceGatewayConfigConnection("Conn", {
            resourceGroup: group.resourceGroupName,
            gatewayName: gateway.gatewayName,
            name: "alchemy-conn",
            workspaceId: workspace.workspaceId,
            hostnames,
          });
    return { group, gateway, connection };
  });

// Needs a Premium service (~$2.8/h, 30-45 min) plus a premium workspace
// gateway (several $/h, 30+ min): est. ~$8 and ~90 minutes per run.
test.provider.skipIf(!runExpensive)(
  "connect, update, and disconnect a workspace on a gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program(["one.example.com"]));
      const rg = first.group.resourceGroupName;
      const gw = first.gateway.gatewayName;
      expect(first.connection?.workspaceId).toContain("/workspaces/alchemy-ws");
      expect(
        (yield* getConnection(rg, gw, "alchemy-conn")).properties.hostnames,
      ).toEqual(["one.example.com"]);

      // In-place update of the hostnames.
      yield* stack.deploy(program(["two.example.com"]));
      expect(
        (yield* getConnection(rg, gw, "alchemy-conn")).properties.hostnames,
      ).toEqual(["two.example.com"]);

      // Removing the resource disconnects the workspace.
      yield* stack.deploy(program());
      expect(yield* untilGone(getConnection(rg, gw, "alchemy-conn"))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
