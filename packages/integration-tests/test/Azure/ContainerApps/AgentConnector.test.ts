import * as Azure from "@alchemy.run/azure";
import * as app from "@distilled.cloud/azure/app";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, waitGone } from "./fixtures/shared.ts";

// SRE Agent regions: swedencentral, eastus2, australiaeast.
const LOCATION = "swedencentral";

/** Microsoft's public sample Kusto cluster. */
const KUSTO_CLUSTER = "https://help.kusto.windows.net";

const { test } = Test.make({ providers: Azure.providers() });

const getConnector = (resourceGroupName: string, agentName: string, connectorName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetAgentsConnector({
      subscriptionId,
      resourceGroupName,
      agentName,
      connectorName,
    });
  });

const program = (props: {
  name?: string;
  database: string;
  extendedProperties: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const agent = yield* Azure.ContainerApps.Agent("Agent", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
    });
    const connector = yield* Azure.ContainerApps.AgentConnector("Kusto", {
      resourceGroup: group.resourceGroupName,
      agent: agent.agentName,
      name: props.name,
      dataConnectorType: "Kusto",
      dataSource: `${KUSTO_CLUSTER}/${props.database}`,
      identity: "system",
      extendedProperties: props.extendedProperties,
    });
    return { group, agent, connector };
  });

// Cost: an SRE Agent bills Azure Agent Units while it exists (always-on
// baseline); a ~10 minute run stays well under $1. Time: ~10 minutes.
test.provider(
  "create, update, replace, and delete an SRE agent connector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, agent, connector } = yield* stack.deploy(
        program({ database: "Samples", extendedProperties: { owner: "alpha" } }),
      );
      expect(connector.connectorName).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
      expect(connector.dataConnectorType).toEqual("Kusto");
      const get = (name: string) => getConnector(group.resourceGroupName, agent.agentName, name);
      const observed = yield* get(connector.connectorName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.dataConnectorType).toEqual("Kusto");
      // Azure echoes `extendedProperties` keys with null values and returns
      // `dataSource` as null, so only the keys are verifiable out of band.
      expect(Object.keys(observed.properties?.extendedProperties ?? {})).toEqual(["owner"]);

      // In-place update: data source database and extended properties.
      const updated = yield* stack.deploy(
        program({ database: "SampleLogs", extendedProperties: { team: "beta" } }),
      );
      expect(updated.connector.connectorId).toEqual(connector.connectorId);
      const reobserved = yield* get(connector.connectorName);
      expect(reobserved.properties?.provisioningState).toEqual("Succeeded");
      expect(Object.keys(reobserved.properties?.extendedProperties ?? {})).toEqual(["team"]);

      // Replacement: a new name creates a new connector.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-kusto-two",
          database: "SampleLogs",
          extendedProperties: { team: "beta" },
        }),
      );
      expect(replaced.connector.connectorName).toEqual("alchemy-kusto-two");
      const oldConnector = yield* waitGone(get(connector.connectorName));
      expect(oldConnector).toEqual("gone");

      yield* stack.destroy();
      // The new connector lives inside the agent, so a gone agent proves both.
      const oldAgent = yield* waitGone(
        Effect.gen(function* () {
          const { subscriptionId } = yield* Azure.AzureEnvironment.current;
          return yield* app.GetAgent({
            subscriptionId,
            resourceGroupName: group.resourceGroupName,
            agentName: agent.agentName,
          });
        }),
      );
      expect(oldAgent).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerapps", "live"],
    timeout: 1_200_000,
  },
);
