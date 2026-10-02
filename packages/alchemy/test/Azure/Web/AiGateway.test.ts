import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getGateway = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetAiGateway({ subscriptionId, resourceGroupName, name });
  });

const gatewayGone = (resourceGroupName: string, name: string) =>
  getGateway(resourceGroupName, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: { location: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const gateway = yield* Azure.Web.AiGateway("Gateway", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      tags: props.tags,
    });
    return { group, gateway };
  });

// `Microsoft.Web/aigateways` (API 2026-07-15) is not rolled out to the test
// subscription: ARM answers `InvalidResourceType`. Set
// AZURE_TEST_WEB_AIGATEWAY=1 once it is available. Expected cost: $0.
const runAiGateway = !!process.env.AZURE_TEST_WEB_AIGATEWAY;

test.provider.skipIf(!runAiGateway)(
  "create, update, replace, and delete an AI gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, gateway } = yield* stack.deploy(
        program({ location: "eastus", tags: { env: "test" } }),
      );
      expect(gateway.location.toLowerCase().replaceAll(" ", "")).toEqual(
        "eastus",
      );
      const observed = yield* getGateway(
        group.resourceGroupName,
        gateway.aiGatewayName,
      );
      expect(observed.id?.toLowerCase()).toEqual(
        gateway.aiGatewayResourceId.toLowerCase(),
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Gateway");

      // In-place update: tags.
      const updated = yield* stack.deploy(
        program({ location: "eastus", tags: { env: "prod" } }),
      );
      expect(updated.gateway.aiGatewayResourceId).toEqual(
        gateway.aiGatewayResourceId,
      );
      const retagged = yield* getGateway(
        group.resourceGroupName,
        gateway.aiGatewayName,
      );
      expect(retagged.tags?.env).toEqual("prod");

      // Replacement: location cannot change in place.
      const replaced = yield* stack.deploy(
        program({ location: "westus2", tags: { env: "prod" } }),
      );
      expect(
        replaced.gateway.location.toLowerCase().replaceAll(" ", ""),
      ).toEqual("westus2");
      expect(
        yield* gatewayGone(group.resourceGroupName, gateway.aiGatewayName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* gatewayGone(
          group.resourceGroupName,
          replaced.gateway.aiGatewayName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);

// Probe: until the type is rolled out, ARM rejects it as InvalidResourceType
// and the provider treats the gateway as absent.
test.provider.skipIf(runAiGateway)(
  "unavailable AI gateway type is rejected with InvalidResourceType",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const error = yield* web
        .AiGatewaysCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          name: "alchemy-aigateway-probe",
          location: "eastus",
          properties: {},
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("InvalidResourceType");
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 300_000,
  },
);
