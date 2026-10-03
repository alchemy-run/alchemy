import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { pollGone, sentinelWorkspace, tags } from "./sentinel.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSetting = (
  resourceGroupName: string,
  workspaceName: string,
  settingsResourceName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* securityinsights.GetSecurityMLAnalyticsSettings({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      settingsResourceName,
    });
  });

const settingGone = (rg: string, ws: string, name: string) =>
  pollGone(
    getSetting(rg, ws, name).pipe(
      Effect.as("found" as const),
      Effect.catchTag(
        ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
        () => Effect.succeed("gone" as const),
      ),
    ),
  );

/** A built-in anomaly definition seeded into the workspace by Microsoft. */
const builtInDefinition = (resourceGroupName: string, workspaceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const page = yield* securityinsights.ListSecurityMLAnalyticsSettings({
      subscriptionId,
      resourceGroupName,
      workspaceName,
    });
    const builtIn = page.value[0];
    if (builtIn?.name === undefined) {
      return yield* Effect.die(new Error("no built-in anomaly settings yet"));
    }
    const full = yield* getSetting(
      resourceGroupName,
      workspaceName,
      builtIn.name,
    );
    return full.properties as Record<string, unknown>;
  });

const program = (opts?: {
  definition: Record<string, unknown>;
  enabled: boolean;
  status: "Flighting" | "Production";
}) =>
  Effect.gen(function* () {
    const { group, logs, sentinel } = yield* sentinelWorkspace;
    const setting = opts
      ? yield* Azure.SecurityInsights.SecurityMLAnalyticsSetting("Anomaly", {
          resourceGroup: sentinel.resourceGroup,
          workspace: sentinel.workspace,
          displayName: "Alchemy tuned anomaly",
          description: "Tuned by the Alchemy test suite",
          enabled: opts.enabled,
          anomalyVersion: String(opts.definition.anomalyVersion),
          frequency: String(opts.definition.frequency),
          settingsStatus: opts.status,
          isDefaultSettings: false,
          settingsDefinitionId: String(opts.definition.settingsDefinitionId),
          customizableObservations: opts.definition
            .customizableObservations as Record<string, unknown>,
        })
      : undefined;
    return { group, logs, setting };
  });

// The free-trial workspace in eastus is not enabled for Sentinel anomalies
// (built-in definitions are seeded hours after onboarding on supported
// workspaces), so creation fails with this typed error.
test.provider(
  "anomaly settings are rejected on a fresh trial workspace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const out = yield* stack.deploy(program());
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const error = yield* securityinsights
        .SecurityMLAnalyticsSettingsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: out.group.resourceGroupName,
          workspaceName: out.logs.workspaceName,
          settingsResourceName: "6b1d6a8e-2f43-4c1a-9d1e-0a5c3b7e9f21",
          kind: "Anomaly",
          properties: {
            displayName: "probe",
            enabled: false,
            anomalyVersion: "1.0.0",
            frequency: "PT1H",
            settingsStatus: "Flighting",
            isDefaultSettings: false,
            settingsDefinitionId: "f209df4c-a1a8-4b2b-9b21-7b4f1a6ad7b6",
            customizableObservations: {},
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("SentinelAnomaliesNotSupported");
      yield* stack.destroy();
    }),
  { tags, timeout: 900_000 },
);

// Needs a workspace with anomalies enabled and built-in definitions seeded
// (hours after onboarding); ~$0 once available.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete Sentinel anomaly settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bare = yield* stack.deploy(program());
      const rg = bare.group.resourceGroupName;
      const ws = bare.logs.workspaceName;
      const definition = yield* builtInDefinition(rg, ws);

      const created = yield* stack.deploy(
        program({ definition, enabled: false, status: "Flighting" }),
      );
      const name = created.setting!.settingsResourceName;
      const observed = yield* getSetting(rg, ws, name);
      expect(
        (observed.properties as Record<string, unknown>).settingsStatus,
      ).toEqual("Flighting");

      yield* stack.deploy(
        program({ definition, enabled: true, status: "Production" }),
      );
      const after = yield* getSetting(rg, ws, name);
      expect((after.properties as Record<string, unknown>).enabled).toEqual(
        true,
      );

      yield* stack.destroy();
      expect(yield* settingGone(rg, ws, name)).toEqual("gone");
    }),
  { tags, timeout: 900_000 },
);
