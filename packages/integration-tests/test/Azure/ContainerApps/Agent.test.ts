import * as Azure from "@alchemy.run/azure";
import * as app from "@distilled.cloud/azure/app";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, waitGone } from "./fixtures/shared.ts";

// SRE Agent regions: swedencentral, eastus2, australiaeast.
const LOCATION = "swedencentral";

const { test } = Test.make({ providers: Azure.providers() });

const getAgent = (resourceGroupName: string, agentName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetAgent({ subscriptionId, resourceGroupName, agentName });
  });

const program = (props: {
  name?: string;
  mode: "Review" | "Autonomous";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    // Actions run as a managed identity attached to the agent.
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("Identity", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
    });
    const agent = yield* Azure.ContainerApps.Agent("Agent", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      name: props.name,
      identity: { type: "UserAssigned", userAssignedIdentities: [identity.identityId] },
      actionConfiguration: {
        identity: identity.identityId,
        mode: props.mode,
        accessLevel: "Low",
      },
      tags: props.tags,
    });
    return { group, identity, agent };
  });

// Cost: an SRE Agent bills Azure Agent Units while it exists (always-on
// baseline); a ~10 minute run stays well under $1. Time: ~10 minutes.
test.provider(
  "create, update, replace, and delete an SRE agent",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, identity, agent } = yield* stack.deploy(
        program({ mode: "Review", tags: { env: "test" } }),
      );
      expect(agent.agentName).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
      expect(agent.tags).toEqual({ env: "test" });
      const observed = yield* getAgent(group.resourceGroupName, agent.agentName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.actionConfiguration?.mode).toEqual("Review");
      expect(observed.identity?.type).toEqual("UserAssigned");
      expect(
        Object.keys(observed.identity?.userAssignedIdentities ?? {}).map((id) => id.toLowerCase()),
      ).toEqual([identity.identityId.toLowerCase()]);
      expect(observed.tags?.["alchemy::id"]).toEqual("Agent");

      // In-place update: action mode (PATCH) and tags.
      const updated = yield* stack.deploy(program({ mode: "Autonomous", tags: { env: "prod" } }));
      expect(updated.agent.agentId).toEqual(agent.agentId);
      const reobserved = yield* getAgent(group.resourceGroupName, agent.agentName);
      expect(reobserved.properties?.actionConfiguration?.mode).toEqual("Autonomous");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: a new name creates a new agent.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-sre-two", mode: "Autonomous", tags: { env: "prod" } }),
      );
      expect(replaced.agent.agentName).toEqual("alchemy-sre-two");
      expect(yield* waitGone(getAgent(group.resourceGroupName, agent.agentName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(getAgent(group.resourceGroupName, "alchemy-sre-two"))).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerapps", "live"],
    timeout: 1_200_000,
  },
);
