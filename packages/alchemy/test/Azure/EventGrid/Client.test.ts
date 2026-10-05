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

// Fixed SHA-256 thumbprints; no device ever connects with them.
const THUMBPRINT_A =
  "3A5F0C2B9E8D7C6B5A4F3E2D1C0B9A8F7E6D5C4B3A2F1E0D9C8B7A6F5E4D3C2B";
const THUMBPRINT_B =
  "B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2C3";

const getClient = (
  resourceGroupName: string,
  namespaceName: string,
  clientName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* eventgrid.GetClient({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      clientName,
    });
  });

const clientGone = (
  resourceGroupName: string,
  namespaceName: string,
  clientName: string,
) =>
  getClient(resourceGroupName, namespaceName, clientName).pipe(
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
  thumbprints: string[];
  attributes: Record<string, string | number | boolean | string[]>;
  state?: "Enabled" | "Disabled";
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
    const client = yield* Azure.EventGrid.Client("Device", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      name: props.name,
      validationScheme: "ThumbprintMatch",
      allowedThumbprints: props.thumbprints,
      attributes: props.attributes,
      state: props.state,
    });
    return { group, namespace, client };
  });

// One throughput unit with the MQTT broker for ~10 minutes; well under $0.10.
test.provider(
  "create, update, rename, and delete an event grid MQTT client",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace, client } = yield* stack.deploy(
        program({
          thumbprints: [THUMBPRINT_A],
          attributes: { role: "sensor" },
        }),
      );
      expect(client.authenticationName).toEqual(client.clientName);
      expect(client.validationScheme).toEqual("ThumbprintMatch");
      expect(client.state).toEqual("Enabled");
      expect(client.attributes).toEqual({ role: "sensor" });
      const observed = yield* getClient(
        group.resourceGroupName,
        namespace.namespaceName,
        client.clientName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(
        observed.properties?.clientCertificateAuthentication?.allowedThumbprints?.map(
          (t) => t.toUpperCase(),
        ),
      ).toEqual([THUMBPRINT_A]);
      expect(observed.properties?.description).toMatch(/^\[alchemy:/);

      // In place: thumbprints, attributes, and state.
      const updated = yield* stack.deploy(
        program({
          thumbprints: [THUMBPRINT_A, THUMBPRINT_B],
          attributes: { role: "gateway", floor: 3 },
          state: "Disabled",
        }),
      );
      expect(updated.client.clientName).toEqual(client.clientName);
      const reobserved = yield* getClient(
        group.resourceGroupName,
        namespace.namespaceName,
        client.clientName,
      );
      expect(reobserved.properties?.state).toEqual("Disabled");
      expect(reobserved.properties?.attributes).toEqual({
        role: "gateway",
        floor: 3,
      });
      expect(
        reobserved.properties?.clientCertificateAuthentication?.allowedThumbprints
          ?.map((t) => t.toUpperCase())
          .sort(),
      ).toEqual([THUMBPRINT_A, THUMBPRINT_B].sort());

      // Renaming replaces the client.
      const renamed = yield* stack.deploy(
        program({
          thumbprints: [THUMBPRINT_A],
          attributes: { role: "sensor" },
          name: "device-renamed",
        }),
      );
      expect(renamed.client.clientName).toEqual("device-renamed");
      expect(renamed.client.authenticationName).toEqual("device-renamed");
      expect(
        yield* clientGone(
          group.resourceGroupName,
          namespace.namespaceName,
          client.clientName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* clientGone(
          group.resourceGroupName,
          namespace.namespaceName,
          "device-renamed",
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:eventgrid", "live"],
    timeout: 600_000,
  },
);
