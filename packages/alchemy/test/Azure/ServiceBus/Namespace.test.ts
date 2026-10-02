import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as servicebus from "@distilled.cloud/azure/servicebus";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getNamespace = (resourceGroupName: string, namespaceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* servicebus.GetNamespace({
      subscriptionId,
      resourceGroupName,
      namespaceName,
    });
  });

const namespaceGone = (resourceGroupName: string, namespaceName: string) =>
  getNamespace(resourceGroupName, namespaceName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (props: {
  tags: Record<string, string>;
  disableLocalAuth: boolean;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const bus = yield* Azure.ServiceBus.Namespace("Bus", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard",
      disableLocalAuth: props.disableLocalAuth,
      tags: props.tags,
    });
    return { group, bus };
  });

// Standard namespace: ~$0.0135/h base charge, a few minutes per run (<$0.01).
test.provider(
  "create, update, and delete a service bus namespace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, bus } = yield* stack.deploy(
        program({ tags: { env: "test" }, disableLocalAuth: false }),
      );
      expect(bus.namespaceName).toMatch(/^[a-z][a-z0-9-]{4,48}[a-z0-9]$/);
      expect(bus.sku).toEqual("Standard");
      expect(bus.hostName).toEqual(
        `${bus.namespaceName}.servicebus.windows.net`,
      );
      expect(bus.tags).toEqual({ env: "test" });
      expect(bus.primaryConnectionString).toBeDefined();
      expect(Redacted.value(bus.primaryConnectionString!)).toContain(
        `Endpoint=sb://${bus.namespaceName}.servicebus.windows.net/`,
      );

      const observed = yield* getNamespace(
        group.resourceGroupName,
        bus.namespaceName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.minimumTlsVersion).toEqual("1.2");
      expect(observed.properties?.disableLocalAuth).toEqual(false);
      expect(observed.sku?.name).toEqual("Standard");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Bus");

      // In place: tags and disableLocalAuth.
      const updated = yield* stack.deploy(
        program({ tags: { env: "prod" }, disableLocalAuth: true }),
      );
      expect(updated.bus.namespaceName).toEqual(bus.namespaceName);
      expect(updated.bus.disableLocalAuth).toEqual(true);
      expect(updated.bus.primaryConnectionString).toBeUndefined();
      const reobserved = yield* getNamespace(
        group.resourceGroupName,
        bus.namespaceName,
      );
      expect(reobserved.properties?.disableLocalAuth).toEqual(true);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* namespaceGone(group.resourceGroupName, bus.namespaceName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:servicebus", "live"],
    timeout: 600_000,
  },
);
