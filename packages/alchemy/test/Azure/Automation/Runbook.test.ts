import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as automation from "@distilled.cloud/azure/automation";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  account,
  logLevel,
  subscription,
  tags,
  waitGone,
  sharedAccountTest,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  runbookType: Azure.Automation.RunbookType;
  content: string;
  description?: string;
  env: string;
}) =>
  Effect.gen(function* () {
    const { where } = yield* account;
    const runbook = yield* Azure.Automation.Runbook("Runbook", {
      ...where,
      runbookType: props.runbookType,
      content: props.content,
      description: props.description,
      logVerbose: props.description !== undefined,
      tags: { env: props.env },
    });
    return { where, runbook };
  });

const request = (
  resourceGroupName: string,
  automationAccountName: string,
  runbookName: string,
) =>
  Effect.map(subscription, (subscriptionId) => ({
    subscriptionId,
    resourceGroupName,
    automationAccountName,
    runbookName,
  }));

// Free: an Automation account plus one runbook (no jobs run), < 1 minute.
test.provider(
  "create, update content, replace, and delete a runbook",
  (stack) =>
    sharedAccountTest(stack)(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { where, runbook } = yield* stack.deploy(
          program({
            runbookType: "PowerShell72",
            content: 'Write-Output "one"',
            env: "a",
          }),
        );
        const req = (name: string) =>
          request(where.resourceGroup, where.automationAccount, name);
        expect(runbook.state).toEqual("Published");
        const observed = yield* automation.GetRunbook(
          yield* req(runbook.runbookName),
        );
        expect(observed.properties?.runbookType).toEqual("PowerShell72");
        expect(observed.tags?.env).toEqual("a");
        expect(
          yield* automation.GetRunbookContent(yield* req(runbook.runbookName)),
        ).toContain('Write-Output "one"');

        // In-place: content, description, log flags, tags.
        const updated = yield* stack.deploy(
          program({
            runbookType: "PowerShell72",
            content: 'Write-Output "two"',
            description: "second",
            env: "b",
          }),
        );
        expect(updated.runbook.runbookId).toEqual(runbook.runbookId);
        expect(updated.runbook.state).toEqual("Published");
        expect(
          yield* automation.GetRunbookContent(yield* req(runbook.runbookName)),
        ).toContain('Write-Output "two"');
        const reobserved = yield* automation.GetRunbook(
          yield* req(runbook.runbookName),
        );
        expect(reobserved.properties?.description).toEqual("second");
        expect(reobserved.properties?.logVerbose).toEqual(true);
        expect(reobserved.tags?.env).toEqual("b");

        // Replacement: the runbook type is immutable.
        const replaced = yield* stack.deploy(
          program({
            runbookType: "Python3",
            content: 'print("three")',
            description: "second",
            env: "b",
          }),
        );
        expect(replaced.runbook.runbookName).not.toEqual(runbook.runbookName);
        expect(replaced.runbook.runbookType).toEqual("Python3");
        expect(
          yield* waitGone(
            automation.GetRunbook(yield* req(runbook.runbookName)),
          ),
        ).toEqual("gone");

        yield* stack.destroy();
        expect(
          yield* waitGone(
            automation.GetRunbook(yield* req(replaced.runbook.runbookName)),
          ),
        ).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
