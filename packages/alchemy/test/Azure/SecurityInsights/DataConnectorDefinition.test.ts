import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { pollGone, sentinelWorkspace, tags } from "./sentinel.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDefinition = (
  resourceGroupName: string,
  workspaceName: string,
  dataConnectorDefinitionName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* securityinsights.GetDataConnectorDefinition({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      dataConnectorDefinitionName,
    });
  });

const definitionGone = (rg: string, ws: string, name: string) =>
  pollGone(
    getDefinition(rg, ws, name).pipe(
      Effect.as("found" as const),
      Effect.catchTag(
        ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
        () => Effect.succeed("gone" as const),
      ),
    ),
  );

const uiConfig = (title: string) => ({
  title,
  publisher: "Alchemy",
  descriptionMarkdown: "Streams Alchemy test events into Sentinel.",
  graphQueries: [
    {
      metricName: "Total events",
      legend: "Alchemy",
      baseQuery: "AlchemyTest_CL",
    },
  ],
  sampleQueries: [
    { description: "All events", query: "AlchemyTest_CL | take 10" },
  ],
  dataTypes: [
    {
      name: "AlchemyTest_CL",
      lastDataReceivedQuery:
        "AlchemyTest_CL | summarize Time = max(TimeGenerated) | where isnotempty(Time)",
    },
  ],
  connectivityCriteria: [{ type: "HasDataConnectors" }],
  permissions: {
    resourceProvider: [
      {
        provider: "Microsoft.OperationalInsights/workspaces",
        permissionsDisplayText: "Read and write permissions are required.",
        providerDisplayName: "Workspace",
        scope: "Workspace",
        requiredPermissions: { write: true, read: true, delete: true },
      },
    ],
  },
  instructionSteps: [
    { title: "Connect", description: "Enter your API key and connect." },
  ],
});

const program = (opts: { title: string; name?: string }) =>
  Effect.gen(function* () {
    const { group, logs, sentinel } = yield* sentinelWorkspace;
    const definition = yield* Azure.SecurityInsights.DataConnectorDefinition(
      "Definition",
      {
        resourceGroup: sentinel.resourceGroup,
        workspace: sentinel.workspace,
        dataConnectorDefinitionName: opts.name,
        connectorUiConfig: uiConfig(opts.title),
      },
    );
    return { group, logs, definition };
  });

// Sentinel trial + empty workspace: ~$0 per run, ~3 minutes.
test.provider(
  "create, update, replace, and delete a Sentinel data connector definition",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ title: "Alchemy v1" }));
      const rg = created.group.resourceGroupName;
      const ws = created.logs.workspaceName;
      const name = created.definition.dataConnectorDefinitionName;
      const observed = yield* getDefinition(rg, ws, name);
      expect(observed.kind).toEqual("Customizable");
      expect(
        (
          (observed.properties as Record<string, unknown>)
            .connectorUiConfig as Record<string, unknown>
        ).title,
      ).toEqual("Alchemy v1");

      const updated = yield* stack.deploy(program({ title: "Alchemy v2" }));
      expect(updated.definition.dataConnectorDefinitionName).toEqual(name);
      const after = yield* getDefinition(rg, ws, name);
      expect(
        (
          (after.properties as Record<string, unknown>)
            .connectorUiConfig as Record<string, unknown>
        ).title,
      ).toEqual("Alchemy v2");

      const replaced = yield* stack.deploy(
        program({ title: "Alchemy v2", name: "AlchemyReplacementConnector" }),
      );
      expect(replaced.definition.dataConnectorDefinitionName).toEqual(
        "AlchemyReplacementConnector",
      );
      expect(yield* definitionGone(rg, ws, name)).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* definitionGone(rg, ws, "AlchemyReplacementConnector"),
      ).toEqual("gone");
    }),
  { tags, timeout: 900_000 },
);
