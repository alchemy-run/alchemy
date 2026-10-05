import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { runExpensive } from "../gates.ts";
import { warehouse } from "./warehouse.ts";
import {
  awaitGone,
  logLevel,
  newPassword,
  SQL_TAGS,
  subscription,
} from "./harness.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getChild = (
  resourceGroupName: string,
  serverName: string,
  databaseName: string,
  workloadGroupName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* sql.GetWorkloadClassifier({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
      databaseName,
      workloadGroupName,
      workloadClassifierName: name,
    });
  });

type Step = { name?: string; importance: "normal" | "high" };

const program = (password: Redacted.Redacted<string>, step: Step) =>
  Effect.gen(function* () {
    const dw = yield* warehouse(password);
    const wg = yield* Azure.Sql.WorkloadGroup("Loads", {
      ...dw.scope,
      minResourcePercent: 10,
      maxResourcePercent: 100,
      minResourcePercentPerRequest: 5,
    });
    const parent = { ...dw, wg };
    const child = yield* Azure.Sql.WorkloadClassifier("Child", {
      ...parent.scope,
      workloadGroup: wg.workloadGroupName,
      name: step.name,
      memberName: "dbo",
      importance: step.importance,
    });
    return { ...parent, child };
  });

// DW100c dedicated SQL pool (~$1.20/hour, 5-10 minutes to provision): about
// $0.40 per run, so this only runs with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a workload classifier",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, { importance: "normal" }),
      );
      const get = (name: string) =>
        getChild(
          first.group.resourceGroupName,
          first.server.serverName,
          first.dw.databaseName,
          first.wg.workloadGroupName,
          name,
        );
      const observed1 = yield* get(first.child.workloadClassifierName);
      expect(observed1.properties?.importance).toEqual("normal");

      // In place update.
      const second = yield* stack.deploy(
        program(password, { importance: "high" }),
      );
      expect(second.child.workloadClassifierId).toEqual(
        first.child.workloadClassifierId,
      );
      const observed2 = yield* get(first.child.workloadClassifierName);
      expect(observed2.properties?.importance).toEqual("high");

      // Renaming replaces the classifier.
      const third = yield* stack.deploy(
        program(password, {
          ...{ importance: "high" },
          name: "alchemy-renamed",
        }),
      );
      expect(third.child.workloadClassifierName).toEqual("alchemy-renamed");
      expect(yield* awaitGone(get(first.child.workloadClassifierName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* awaitGone(get("alchemy-renamed"))).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 900_000 },
);
