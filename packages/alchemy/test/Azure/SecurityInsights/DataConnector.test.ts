import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { pollGone, sentinelWorkspace, tags } from "./sentinel.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnector = (
  resourceGroupName: string,
  workspaceName: string,
  dataConnectorId: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* securityinsights.GetDataConnector({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      dataConnectorId,
    });
  });

const connectorGone = (rg: string, ws: string, id: string) =>
  pollGone(
    getConnector(rg, ws, id).pipe(
      Effect.as("found" as const),
      Effect.catchTag(
        ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
        () => Effect.succeed("gone" as const),
      ),
    ),
  );

const REPLACEMENT_ID = "2d7c9e41-6a3b-4f8e-9c1d-7e5a3b2f1c09";

const program = (opts: { lookback: string; connectorId?: string }) =>
  Effect.gen(function* () {
    const { group, logs, sentinel } = yield* sentinelWorkspace;
    const connector = yield* Azure.SecurityInsights.DataConnector("Ti", {
      resourceGroup: sentinel.resourceGroup,
      workspace: sentinel.workspace,
      dataConnectorId: opts.connectorId,
      kind: "ThreatIntelligence",
      properties: {
        tipLookbackPeriod: opts.lookback,
        dataTypes: { indicators: { state: "Enabled" } },
      },
    });
    return { group, logs, connector };
  });

// Sentinel trial + empty workspace, no threat feeds ingested: ~$0, ~3 minutes.
test.provider(
  "create, update, replace, and delete a Sentinel data connector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ lookback: "2026-01-01T00:00:00Z" }),
      );
      const rg = created.group.resourceGroupName;
      const ws = created.logs.workspaceName;
      const connectorId = created.connector.dataConnectorId;
      const observed = yield* getConnector(rg, ws, connectorId);
      expect(observed.kind).toEqual("ThreatIntelligence");

      const updated = yield* stack.deploy(
        program({ lookback: "2026-02-01T00:00:00Z" }),
      );
      expect(updated.connector.dataConnectorId).toEqual(connectorId);
      const after = yield* getConnector(rg, ws, connectorId);
      expect(
        String(
          (after.properties as Record<string, unknown>).tipLookbackPeriod,
        ),
      ).toContain("2026-02-01");

      const replaced = yield* stack.deploy(
        program({
          lookback: "2026-02-01T00:00:00Z",
          connectorId: REPLACEMENT_ID,
        }),
      );
      expect(replaced.connector.dataConnectorId).toEqual(REPLACEMENT_ID);
      expect(yield* connectorGone(rg, ws, connectorId)).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* connectorGone(rg, ws, replaced.connector.dataConnectorId),
      ).toEqual("gone");
    }),
  { tags, timeout: 900_000 },
);
