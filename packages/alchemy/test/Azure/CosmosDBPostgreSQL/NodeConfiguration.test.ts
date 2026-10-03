import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as postgresqlhsc from "@distilled.cloud/azure/postgresqlhsc";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { clusterRef, existingCluster, logLevel, tags } from "./cluster.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConfiguration = (configurationName: string) =>
  Effect.gen(function* () {
    const ref = yield* clusterRef(
      existingCluster!.resourceGroup,
      existingCluster!.cluster,
    );
    return yield* postgresqlhsc.GetConfigurationNode({
      ...ref,
      configurationName,
    });
  });

const program = (props: { name: string; value: string }) =>
  Azure.CosmosDBPostgreSQL.NodeConfiguration("SlowLog", {
    resourceGroup: existingCluster!.resourceGroup,
    cluster: existingCluster!.cluster,
    name: props.name,
    value: props.value,
  });

// New clusters cannot be provisioned (service retirement); runs against an
// existing cluster from AZURE_COSMOS_PG_CLUSTER. Parameters are free.
test.provider.skipIf(existingCluster === undefined)(
  "set, update, replace, and reset a node parameter",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const config = yield* stack.deploy(
        program({ name: "log_min_duration_statement", value: "500" }),
      );
      expect(config.value).toEqual("500");
      expect(
        (yield* getConfiguration("log_min_duration_statement")).properties
          ?.value,
      ).toEqual("500");

      // The value is mutable in place.
      const updated = yield* stack.deploy(
        program({ name: "log_min_duration_statement", value: "1000" }),
      );
      expect(updated.configurationId).toEqual(config.configurationId);
      expect(
        (yield* getConfiguration("log_min_duration_statement")).properties
          ?.value,
      ).toEqual("1000");

      // Changing the parameter name replaces it: the old one is reset.
      const renamed = yield* stack.deploy(
        program({ name: "log_lock_waits", value: "on" }),
      );
      expect(renamed.configurationName).toEqual("log_lock_waits");
      const reset = yield* getConfiguration("log_min_duration_statement");
      expect(reset.properties?.value).toEqual(reset.properties?.defaultValue);

      // Delete restores the default.
      yield* stack.destroy();
      const restored = yield* getConfiguration("log_lock_waits");
      expect(restored.properties?.value).toEqual(
        restored.properties?.defaultValue,
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
