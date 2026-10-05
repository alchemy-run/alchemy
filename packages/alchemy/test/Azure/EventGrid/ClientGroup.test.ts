import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getGroup = (
  resourceGroupName: string,
  namespaceName: string,
  clientGroupName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* eventgrid.GetClientGroup({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      clientGroupName,
    });
  });

const groupGone = (
  resourceGroupName: string,
  namespaceName: string,
  clientGroupName: string,
) =>
  getGroup(resourceGroupName, namespaceName, clientGroupName).pipe(
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

const program = (props: {
  query: string;
  description?: string;
  name?: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const namespace = yield* Azure.EventGrid.Namespace("Broker", {
      resourceGroup: group.resourceGroupName,
      topicSpacesConfiguration: { state: "Enabled" },
    });
    const clientGroup = yield* Azure.EventGrid.ClientGroup("Sensors", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      name: props.name,
      query: props.query,
      description: props.description,
    });
    return { group, namespace, clientGroup };
  });

// One throughput unit with the MQTT broker for ~10 minutes; well under $0.10.
test.provider(
  "create, update, rename, and delete an event grid MQTT client group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace, clientGroup } = yield* stack.deploy(
        program({ query: "attributes.role = 'sensor'" }),
      );
      expect(clientGroup.query).toEqual("attributes.role = 'sensor'");
      expect(clientGroup.description).toBeUndefined();
      const observed = yield* getGroup(
        group.resourceGroupName,
        namespace.namespaceName,
        clientGroup.clientGroupName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.description).toMatch(/^\[alchemy:/);

      // In place: query and description.
      const updated = yield* stack.deploy(
        program({
          query: "attributes.role IN ['sensor', 'gateway']",
          description: "sensors and gateways",
        }),
      );
      expect(updated.clientGroup.clientGroupName).toEqual(
        clientGroup.clientGroupName,
      );
      expect(updated.clientGroup.description).toEqual("sensors and gateways");
      const reobserved = yield* getGroup(
        group.resourceGroupName,
        namespace.namespaceName,
        clientGroup.clientGroupName,
      );
      expect(reobserved.properties?.query).toEqual(
        "attributes.role IN ['sensor', 'gateway']",
      );
      expect(reobserved.properties?.description).toMatch(
        /^sensors and gateways \[alchemy:/,
      );

      // Renaming replaces the group.
      const renamed = yield* stack.deploy(
        program({
          query: "attributes.role IN ['sensor', 'gateway']",
          name: "sensors-renamed",
        }),
      );
      expect(renamed.clientGroup.clientGroupName).toEqual("sensors-renamed");
      expect(
        yield* groupGone(
          group.resourceGroupName,
          namespace.namespaceName,
          clientGroup.clientGroupName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* groupGone(
          group.resourceGroupName,
          namespace.namespaceName,
          "sensors-renamed",
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:eventgrid", "live"],
    timeout: 600_000,
  },
);
