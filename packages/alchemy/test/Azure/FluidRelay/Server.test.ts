import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as fluidrelay from "@distilled.cloud/azure/fluidrelay";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const tags = ["provider:azure", "provider:azure:fluidrelay", "live"];

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getServer = (resourceGroup: string, fluidRelayServerName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* fluidrelay.GetFluidRelayServer({
      subscriptionId,
      resourceGroup,
      fluidRelayServerName,
    });
  });

/** Poll an out-of-band GET until it reports a typed not-found. */
const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
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
  location: string;
  tags: Record<string, string>;
  identity?: Azure.FluidRelay.ServerIdentity;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const server = yield* Azure.FluidRelay.Server("Relay", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      tags: props.tags,
      identity: props.identity,
    });
    return { group, server };
  });

// Fluid Relay bills per operation / connection minute; an idle server
// costs ~$0 and provisions in under a minute.
test.provider(
  "create, update tags and identity, replace via location, and delete a server",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, server } = yield* stack.deploy(
        program({ location: "eastus", tags: { env: "test" } }),
      );
      expect(server.frsTenantId).not.toEqual("");
      expect(server.serviceEndpoints.length).toBeGreaterThan(0);
      expect(server.storagesku).toEqual("standard");
      expect(server.primaryKey).toBeDefined();
      expect(Redacted.value(server.primaryKey!).length).toBeGreaterThan(0);
      const observed = yield* getServer(
        group.resourceGroupName,
        server.serverName,
      );
      expect(observed.properties?.frsTenantId).toEqual(server.frsTenantId);
      expect(observed.tags?.env).toEqual("test");

      expect(server.principalId).toBeUndefined();

      // In-place: tags and a system-assigned identity.
      const updated = yield* stack.deploy(
        program({
          location: "eastus",
          tags: { env: "updated" },
          identity: { type: "SystemAssigned" },
        }),
      );
      expect(updated.server.serverId).toEqual(server.serverId);
      expect(updated.server.tags).toEqual({ env: "updated" });
      expect(updated.server.principalId).toBeDefined();
      const reobserved = yield* getServer(
        group.resourceGroupName,
        server.serverName,
      );
      expect(reobserved.tags?.env).toEqual("updated");
      expect(reobserved.identity?.type).toEqual("SystemAssigned");

      // Replacement: location is immutable. (`storagesku: "basic"` would be
      // the natural replacement trigger, but ARM answers 500 for it.)
      const replaced = yield* stack.deploy(
        program({
          location: "westus2",
          tags: { env: "updated" },
          identity: { type: "SystemAssigned" },
        }),
      );
      expect(replaced.server.serverName).not.toEqual(server.serverName);
      const replacedObserved = yield* getServer(
        group.resourceGroupName,
        replaced.server.serverName,
      );
      expect(replacedObserved.location.toLowerCase()).toEqual("westus2");
      expect(
        yield* waitGone(getServer(group.resourceGroupName, server.serverName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getServer(group.resourceGroupName, replaced.server.serverName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
