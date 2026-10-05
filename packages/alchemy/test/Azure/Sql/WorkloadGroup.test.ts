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
  name: string,
) =>
  Effect.gen(function* () {
    return yield* sql.GetWorkloadGroup({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
      databaseName,
      workloadGroupName: name,
    });
  });

type Step = { name?: string; maxResourcePercent: number };

const program = (password: Redacted.Redacted<string>, step: Step) =>
  Effect.gen(function* () {
    const parent = yield* warehouse(password);
    const child = yield* Azure.Sql.WorkloadGroup("Child", {
      ...parent.scope,
      name: step.name,
      minResourcePercent: 10,
      maxResourcePercent: step.maxResourcePercent,
      minResourcePercentPerRequest: 5,
    });
    return { ...parent, child };
  });

// DW100c dedicated SQL pool (~$1.20/hour, 5-10 minutes to provision): about
// $0.40 per run, so this only runs with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a workload group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, { maxResourcePercent: 100 }),
      );
      const get = (name: string) =>
        getChild(
          first.group.resourceGroupName,
          first.server.serverName,
          first.dw.databaseName,
          name,
        );
      const observed1 = yield* get(first.child.workloadGroupName);
      expect(observed1.properties?.maxResourcePercent).toEqual(100);

      // In place update.
      const second = yield* stack.deploy(
        program(password, { maxResourcePercent: 50 }),
      );
      expect(second.child.workloadGroupId).toEqual(first.child.workloadGroupId);
      const observed2 = yield* get(first.child.workloadGroupName);
      expect(observed2.properties?.maxResourcePercent).toEqual(50);

      // Renaming replaces the workload group.
      const third = yield* stack.deploy(
        program(password, {
          ...{ maxResourcePercent: 50 },
          name: "alchemy-renamed",
        }),
      );
      expect(third.child.workloadGroupName).toEqual("alchemy-renamed");
      expect(yield* awaitGone(get(first.child.workloadGroupName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* awaitGone(get("alchemy-renamed"))).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 900_000 },
);
