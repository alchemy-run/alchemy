import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runExpensive, runPaidOnly } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getEnvironment = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetAppServiceEnvironment({
      subscriptionId,
      resourceGroupName,
      name,
    });
  });

const environmentGone = (resourceGroupName: string, name: string) =>
  getEnvironment(resourceGroupName, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("30 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

const program = (props: { tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      addressPrefixes: ["10.50.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Subnet", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.50.0.0/24",
      delegations: [{ serviceName: "Microsoft.Web/hostingEnvironments" }],
    });
    const ase = yield* Azure.Web.AppServiceEnvironment("Ase", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      subnetId: subnet.subnetId,
      tags: props.tags,
    });
    return { group, ase };
  });

// An ASEv3 takes 1-3 hours to provision and again to delete, bills the
// Isolated v2 minimum (~$0.40+/h, a few dollars per run), and the free
// trial has zero Isolated quota. Runs only with AZURE_TEST_EXPENSIVE=1 and
// AZURE_TEST_PAID=1 (and a raised --timeout).
test.provider.skipIf(!(runExpensive && runPaidOnly))(
  "create, update, and delete an App Service Environment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, ase } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const observed = yield* getEnvironment(
        group.resourceGroupName,
        ase.appServiceEnvironmentName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Ase");

      // In-place update: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.ase.appServiceEnvironmentId).toEqual(
        ase.appServiceEnvironmentId,
      );
      const retagged = yield* getEnvironment(
        group.resourceGroupName,
        ase.appServiceEnvironmentName,
      );
      expect(retagged.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* environmentGone(
          group.resourceGroupName,
          ase.appServiceEnvironmentName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 4 * 60 * 60_000,
  },
);
