import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
      // A missing setting is a 200 with an empty `{}` body.
      Effect.map((s) =>
        s.id === undefined ? ("gone" as const) : ("found" as const),
      ),
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
    // Built-in definitions are seeded a few seconds after onboarding.
    const page = yield* securityinsights
      .ListSecurityMLAnalyticsSettings({
        subscriptionId,
        resourceGroupName,
        workspaceName,
      })
      .pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (p) => p.value.length > 0,
          times: 18,
        }),
      );
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

// ~$0: a pay-as-you-go workspace seeds the built-in anomaly definitions
// seconds after onboarding.
test.provider(
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
