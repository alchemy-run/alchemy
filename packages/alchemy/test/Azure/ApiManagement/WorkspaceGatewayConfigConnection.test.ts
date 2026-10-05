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

// Workspace gateway connections activate in East Asia; in westus and
// norwayeast they end in `ActivationFailed`, and northcentralus /
// francecentral have no gateway capacity ("No resource pool available for
// I2v2").
const location = "eastasia";

const program = (target?: "a" | "b") =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    // Workspace gateways connect to workspaces of a Premium service in the
    // same region.
    const service = yield* Azure.ApiManagement.Service("Premium", {
      resourceGroup: group.resourceGroupName,
      location,
      sku: { name: "Premium", capacity: 1 },
      publisherEmail: "ops@example.com",
      publisherName: "Alchemy",
    });
    // Both workspaces stay deployed across the replacement step.
    const teamA = yield* Azure.ApiManagement.Workspace("TeamA", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-ws-a",
    });
    const teamB = yield* Azure.ApiManagement.Workspace("TeamB", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-ws-b",
    });
    const gateway = yield* Azure.ApiManagement.WorkspaceGateway("Gateway", {
      resourceGroup: group.resourceGroupName,
      location,
    });
    const connection =
      target === undefined
        ? undefined
        : yield* Azure.ApiManagement.WorkspaceGatewayConfigConnection("Conn", {
            resourceGroup: group.resourceGroupName,
            gatewayName: gateway.gatewayName,
            workspaceId: (target === "a" ? teamA : teamB).workspaceId,
          });
    return { group, gateway, connection };
  });

// Needs a Premium service (~$2.8/h, 25-35 min) plus a premium workspace
// gateway (~$1.4/h): est. ~$3 and ~50 minutes per run.
// Skipped: failed in the last live run. InternalServerError:
test.provider.skip(
  "connect, re-point, and disconnect a workspace on a gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("a"));
      const rg = first.group.resourceGroupName;
      const gw = first.gateway.gatewayName;
      const firstName = first.connection!.connectionName;
      expect(first.connection?.workspaceId).toContain(
        "/workspaces/alchemy-ws-a",
      );
      expect(first.connection?.defaultHostname).toContain(".azure-api.net");
      const observed = yield* getConnection(rg, gw, firstName);
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.sourceId).toContain(
        "/workspaces/alchemy-ws-a",
      );

      // Replacement: serving another workspace creates a new connection and
      // removes the old one.
      const second = yield* stack.deploy(program("b"));
      const secondName = second.connection!.connectionName;
      expect(secondName).not.toEqual(firstName);
      expect(
        (yield* getConnection(rg, gw, secondName)).properties.sourceId,
      ).toContain("/workspaces/alchemy-ws-b");
      expect(yield* untilGone(getConnection(rg, gw, firstName))).toEqual(
        "gone",
      );

      // Removing the resource disconnects the workspace.
      yield* stack.deploy(program());
      expect(yield* untilGone(getConnection(rg, gw, secondName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 10_800_000 },
);
