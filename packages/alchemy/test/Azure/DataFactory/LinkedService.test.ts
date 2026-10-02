import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as datafactory from "@distilled.cloud/azure/datafactory";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getLinkedService = (
  resourceGroupName: string,
  factoryName: string,
  linkedServiceName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* datafactory.GetLinkedService({
      subscriptionId,
      resourceGroupName,
      factoryName,
      linkedServiceName,
    });
  });

const linkedServiceGone = (
  resourceGroupName: string,
  factoryName: string,
  linkedServiceName: string,
) =>
  getLinkedService(resourceGroupName, factoryName, linkedServiceName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const program = (props: {
  type: "RestService" | "HttpServer";
  description: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("LinkedServiceGroup", {
      location: "eastus",
    });
    const factory = yield* Azure.DataFactory.Factory("LinkedServiceFactory", {
      resourceGroup: group.resourceGroupName,
    });
    const linkedService = yield* Azure.DataFactory.LinkedService("Api", {
      resourceGroup: group.resourceGroupName,
      factoryName: factory.factoryName,
      type: props.type,
      typeProperties:
        props.type === "RestService"
          ? { url: "https://example.com/api", authenticationType: "Anonymous" }
          : {
              url: "https://example.com/files",
              authenticationType: "Anonymous",
            },
      description: props.description,
      annotations: ["integration-test"],
    });
    return { group, factory, linkedService };
  });

// ~$0: linked service definitions are free. ~1-2 minutes.
test.provider(
  "create, update, replace, and delete a linked service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, factory, linkedService } = yield* stack.deploy(
        program({ type: "RestService", description: "public api" }),
      );
      expect(linkedService.linkedServiceName).toMatch(/^[A-Za-z0-9_]+$/);
      expect(linkedService.type).toEqual("RestService");
      expect(linkedService.annotations).toEqual(["integration-test"]);
      const observed = yield* getLinkedService(
        group.resourceGroupName,
        factory.factoryName,
        linkedService.linkedServiceName,
      );
      expect(observed.properties.description).toEqual("public api");
      expect(observed.properties.typeProperties).toMatchObject({
        url: "https://example.com/api",
        authenticationType: "Anonymous",
      });
      expect(observed.properties.annotations).toContain("integration-test");
      expect(
        observed.properties.annotations?.some(
          (a) => typeof a === "string" && a.startsWith("alchemy:"),
        ),
      ).toBe(true);

      // In place: description.
      const updated = yield* stack.deploy(
        program({ type: "RestService", description: "public api v2" }),
      );
      expect(updated.linkedService.linkedServiceName).toEqual(
        linkedService.linkedServiceName,
      );
      const reobserved = yield* getLinkedService(
        group.resourceGroupName,
        factory.factoryName,
        linkedService.linkedServiceName,
      );
      expect(reobserved.properties.description).toEqual("public api v2");

      // Type change replaces the linked service.
      const replaced = yield* stack.deploy(
        program({ type: "HttpServer", description: "public api v2" }),
      );
      expect(replaced.linkedService.linkedServiceName).not.toEqual(
        linkedService.linkedServiceName,
      );
      const replacedObserved = yield* getLinkedService(
        group.resourceGroupName,
        factory.factoryName,
        replaced.linkedService.linkedServiceName,
      );
      expect(replacedObserved.properties.type).toEqual("HttpServer");
      expect(
        yield* linkedServiceGone(
          group.resourceGroupName,
          factory.factoryName,
          linkedService.linkedServiceName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* linkedServiceGone(
          group.resourceGroupName,
          factory.factoryName,
          replaced.linkedService.linkedServiceName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:datafactory", "live"],
    timeout: 600_000,
  },
);
