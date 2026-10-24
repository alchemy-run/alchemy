import * as Azure from "@alchemy.run/azure";
import * as cloudhealth from "@distilled.cloud/azure/cloudhealth";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { gone, logLevel, modelProgram, modelWhere, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDefinition = (rg: string, model: string, signalDefinitionName: string) =>
  Effect.flatMap(modelWhere(rg, model), (where) =>
    cloudhealth.GetSignalDefinition({ ...where, signalDefinitionName }),
  );

const metric = (props: { threshold: number; env: string }) =>
  ({
    signalKind: "AzureResourceMetric",
    displayName: "Availability",
    metricNamespace: "microsoft.storage/storageaccounts",
    metricName: "Availability",
    aggregationType: "Average",
    timeGrain: "PT5M",
    dataUnit: "Percent",
    evaluationRules: {
      degradedRule: { operator: "LessThan", threshold: 99.9 },
      unhealthyRule: { operator: "LessThan", threshold: props.threshold },
    },
    tags: { env: props.env },
  }) as const;

const query = {
  signalKind: "LogAnalyticsQuery",
  displayName: "Failed requests",
  queryText: "AppRequests | where Success == false | count",
  timeGrain: "PT15M",
  refreshInterval: "PT5M",
  evaluationRules: {
    unhealthyRule: { operator: "GreaterThan", threshold: 10 },
  },
} as const;

const program = (props: ReturnType<typeof metric> | typeof query) =>
  Effect.gen(function* () {
    const { group, model } = yield* modelProgram;
    const signal = yield* Azure.CloudHealth.SignalDefinition("Signal", {
      resourceGroup: group.resourceGroupName,
      healthModel: model.healthModelName,
      ...props,
    });
    return { group, model, signal };
  });

// An empty health model is free; a few minutes per run.
test.provider(
  "create, update, replace, and delete a health model signal definition",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, model, signal } = yield* stack.deploy(
        program(metric({ threshold: 99, env: "test" })),
      );
      const rg = group.resourceGroupName;
      const hm = model.healthModelName;
      expect(signal.signalKind).toEqual("AzureResourceMetric");
      expect(signal.tags).toEqual({ env: "test" });
      const observed = yield* getDefinition(rg, hm, signal.signalDefinitionName);
      expect(observed.properties?.metricName).toEqual("Availability");
      expect(observed.properties?.metricNamespace).toEqual("microsoft.storage/storageaccounts");
      expect(observed.properties?.aggregationType).toEqual("Average");
      expect(observed.properties?.evaluationRules.unhealthyRule.threshold).toEqual(99);
      expect(observed.properties?.tags?.["alchemy::id"]).toEqual("Signal");

      // In place: thresholds and tags.
      const updated = yield* stack.deploy(program(metric({ threshold: 95, env: "prod" })));
      expect(updated.signal.signalDefinitionId).toEqual(signal.signalDefinitionId);
      const reobserved = yield* getDefinition(rg, hm, signal.signalDefinitionName);
      expect(reobserved.properties?.evaluationRules.unhealthyRule.threshold).toEqual(95);
      expect(reobserved.properties?.tags?.env).toEqual("prod");

      // Replacement: the signal kind is fixed.
      const replaced = yield* stack.deploy(program(query));
      expect(replaced.signal.signalDefinitionName).not.toEqual(signal.signalDefinitionName);
      const fresh = yield* getDefinition(rg, hm, replaced.signal.signalDefinitionName);
      expect(fresh.properties?.signalKind).toEqual("LogAnalyticsQuery");
      expect(fresh.properties?.queryText).toEqual(query.queryText);
      expect(fresh.properties?.refreshInterval).toEqual("PT5M");
      const replacedOld = yield* gone(getDefinition(rg, hm, signal.signalDefinitionName));
      expect(replacedOld).toEqual("gone");

      yield* stack.destroy();
      const destroyed = yield* gone(getDefinition(rg, hm, replaced.signal.signalDefinitionName));
      expect(destroyed).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
