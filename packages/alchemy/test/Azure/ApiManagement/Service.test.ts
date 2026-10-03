import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getService = (resourceGroupName: string, serviceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* apim.GetApiManagementService({
      subscriptionId,
      resourceGroupName,
      serviceName,
    });
  });

const serviceGone = (resourceGroupName: string, serviceName: string) =>
  getService(resourceGroupName, serviceName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

/** The soft-deleted copy must be purged too, or the name stays reserved. */
const purged = (location: string, serviceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* apim
      .GetDeletedServiceByName({ subscriptionId, location, serviceName })
      .pipe(
        Effect.as("soft-deleted" as const),
        Effect.catchTag("ApiManagementServiceNotFound", () =>
          Effect.succeed("purged" as const),
        ),
      );
  });

const program = (props: {
  location: string;
  publisherName: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const service = yield* Azure.ApiManagement.Service("Gateway", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      publisherEmail: "ops@example.com",
      publisherName: props.publisherName,
      tags: props.tags,
    });
    return { group, service };
  });

// Consumption tier: no idle cost, first 1M calls free; ~2-5 min to provision.
test.provider(
  "create, update, and delete a Consumption API Management service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service } = yield* stack.deploy(
        program({
          location: "eastus",
          publisherName: "Alchemy",
          tags: { env: "test" },
        }),
      );
      expect(service.sku).toEqual("Consumption");
      expect(service.capacity).toEqual(0);
      expect(service.gatewayUrl).toEqual(
        `https://${service.serviceName}.azure-api.net`,
      );
      const observed = yield* getService(
        group.resourceGroupName,
        service.serviceName,
      );
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.publisherName).toEqual("Alchemy");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Gateway");

      // In-place update: publisher name and tags.
      const updated = yield* stack.deploy(
        program({
          location: "eastus",
          publisherName: "Alchemy Updated",
          tags: { env: "prod" },
        }),
      );
      expect(updated.service.serviceName).toEqual(service.serviceName);
      const reobserved = yield* getService(
        group.resourceGroupName,
        service.serviceName,
      );
      expect(reobserved.properties.publisherName).toEqual("Alchemy Updated");
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* serviceGone(group.resourceGroupName, service.serviceName),
      ).toEqual("gone");
      expect(yield* purged("eastus", service.serviceName)).toEqual("purged");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:apimanagement", "live"],
    timeout: 600_000,
  },
);

// Two Consumption services in sequence (~5-10 min); still no idle cost.
test.provider(
  "changing the location replaces the service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ location: "eastus", publisherName: "Alchemy", tags: {} }),
      );
      const second = yield* stack.deploy(
        program({ location: "westus2", publisherName: "Alchemy", tags: {} }),
      );
      expect(second.service.serviceName).not.toEqual(first.service.serviceName);
      expect(second.service.location.replaceAll(" ", "").toLowerCase()).toEqual(
        "westus2",
      );
      expect(
        yield* serviceGone(
          first.group.resourceGroupName,
          first.service.serviceName,
        ),
      ).toEqual("gone");
      expect(yield* purged("eastus", first.service.serviceName)).toEqual(
        "purged",
      );

      yield* stack.destroy();
      expect(
        yield* serviceGone(
          second.group.resourceGroupName,
          second.service.serviceName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:apimanagement", "live"],
    timeout: 600_000,
  },
);
