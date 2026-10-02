import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { pollGone, sentinelWorkspace, tags } from "./sentinel.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getMetadata = (
  resourceGroupName: string,
  workspaceName: string,
  metadataName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* securityinsights.GetMetadata({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      metadataName,
    });
  });

const metadataGone = (rg: string, ws: string, name: string) =>
  pollGone(
    getMetadata(rg, ws, name).pipe(
      Effect.as("found" as const),
      Effect.catchTag(
        ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
        () => Effect.succeed("gone" as const),
      ),
    ),
  );

const program = (opts: { version: string; name?: string }) =>
  Effect.gen(function* () {
    const { group, logs, sentinel } = yield* sentinelWorkspace;
    const rule = yield* Azure.SecurityInsights.AlertRule("Rule", {
      resourceGroup: sentinel.resourceGroup,
      workspace: sentinel.workspace,
      displayName: "Alchemy metadata rule",
      severity: "Low",
      query: "Heartbeat | take 1",
      queryFrequency: "PT1H",
      queryPeriod: "PT1H",
    });
    const metadata = yield* Azure.SecurityInsights.Metadata("RuleMetadata", {
      resourceGroup: sentinel.resourceGroup,
      workspace: sentinel.workspace,
      metadataName: opts.name,
      kind: "AnalyticsRule",
      parentId: rule.alertRuleResourceId,
      contentId: rule.ruleId,
      version: opts.version,
      source: { kind: "LocalWorkspace" },
      author: { name: "Alchemy" },
      support: { tier: "Community" },
    });
    return { group, logs, rule, metadata };
  });

// Sentinel trial + empty workspace: ~$0 per run, ~3 minutes.
test.provider(
  "create, update, replace, and delete Sentinel content metadata",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ version: "1.0.0" }));
      const rg = created.group.resourceGroupName;
      const ws = created.logs.workspaceName;
      const name = created.metadata.metadataName;
      const observed = yield* getMetadata(rg, ws, name);
      expect(observed.properties?.kind).toEqual("AnalyticsRule");
      expect(observed.properties?.version).toEqual("1.0.0");
      expect(observed.properties?.parentId?.toLowerCase()).toEqual(
        created.rule.alertRuleResourceId.toLowerCase(),
      );

      const updated = yield* stack.deploy(program({ version: "1.1.0" }));
      expect(updated.metadata.metadataName).toEqual(name);
      const after = yield* getMetadata(rg, ws, name);
      expect(after.properties?.version).toEqual("1.1.0");

      const replaced = yield* stack.deploy(
        program({ version: "1.1.0", name: "alchemy-metadata-replacement" }),
      );
      expect(replaced.metadata.metadataName).toEqual(
        "alchemy-metadata-replacement",
      );
      expect(yield* metadataGone(rg, ws, name)).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* metadataGone(rg, ws, "alchemy-metadata-replacement"),
      ).toEqual("gone");
    }),
  { tags, timeout: 900_000 },
);
