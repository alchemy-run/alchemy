import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as automation from "@distilled.cloud/azure/automation";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  account,
  logLevel,
  sharedAccountTest,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  name?: string;
  frequency: number;
  description?: string;
}) =>
  Effect.gen(function* () {
    const { where } = yield* account;
    const runbook = yield* Azure.Automation.Runbook("WatchRunbook", {
      ...where,
      runbookType: "PowerShell",
      content: 'Write-Output "watching"',
    });
    // Watchers only run on hybrid workers; an empty group is enough to
    // create one (it stays stopped).
    const workers = yield* Azure.Automation.HybridRunbookWorkerGroup(
      "Workers",
      where,
    );
    const watcher = yield* Azure.Automation.Watcher("Watcher", {
      ...where,
      name: props.name,
      scriptName: runbook.runbookName,
      scriptRunOn: workers.hybridRunbookWorkerGroupName,
      executionFrequencyInSeconds: props.frequency,
      description: props.description,
    });
    return { where, watcher };
  });

const getWatcher = (
  resourceGroupName: string,
  automationAccountName: string,
  watcherName: string,
) =>
  Effect.gen(function* () {
    return yield* automation.GetWatcher({
      subscriptionId: yield* subscription,
      resourceGroupName,
      automationAccountName,
      watcherName,
    });
  });

// Free: the watcher sits idle on an empty worker group; seconds.
test.provider(
  "create, replace, and delete a watcher",
  (stack) =>
    sharedAccountTest(stack)(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { where, watcher } = yield* stack.deploy(
          program({ frequency: 30 }),
        );
        const get = (name: string) =>
          getWatcher(where.resourceGroup, where.automationAccount, name);
        const observed = yield* get(watcher.watcherName);
        expect(observed.properties?.executionFrequencyInSeconds).toEqual(30);

        // No-op redeploy keeps the watcher.
        const same = yield* stack.deploy(program({ frequency: 30 }));
        expect(same.watcher.watcherId).toEqual(watcher.watcherId);

        // Replacement: watchers cannot be updated unless stopped, and one on
        // an empty worker group is "Failed", so every change replaces it.
        const replaced = yield* stack.deploy(
          program({ frequency: 60, description: "slower" }),
        );
        expect(replaced.watcher.watcherName).not.toEqual(watcher.watcherName);
        const reobserved = yield* get(replaced.watcher.watcherName);
        expect(reobserved.properties?.executionFrequencyInSeconds).toEqual(60);
        expect(reobserved.properties?.description).toEqual("slower");
        expect(yield* waitGone(get(watcher.watcherName))).toEqual("gone");

        yield* stack.destroy();
        expect(yield* waitGone(get(replaced.watcher.watcherName))).toEqual(
          "gone",
        );
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
