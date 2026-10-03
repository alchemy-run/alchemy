import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as workflows from "@distilled.cloud/cloudflare/workflows";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const main = `${import.meta.dirname}/fixtures/event-triggers/worker.ts`;

const tags = [
  "provider:cloudflare",
  "provider:cloudflare:worker",
  "provider:cloudflare:workflow",
  "live",
];

/** The script's triggers as Cloudflare stores them, out of band. */
const storedTriggers = (accountId: string, scriptName: string) =>
  workers
    .getScriptEventTriggers({ accountId, scriptName })
    .pipe(Effect.map((stored) => stored.triggers));

const expectWorkerGone = (accountId: string, scriptName: string) =>
  workers.getScriptScriptAndVersionSetting({ accountId, scriptName }).pipe(
    Effect.as(false),
    Effect.catchTag("WorkerNotFound", () => Effect.succeed(true)),
    Effect.catchTag("WorkerHasNoVersions", () => Effect.succeed(false)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: Boolean,
      times: 10,
    }),
    Effect.tap((gone) => Effect.sync(() => expect(gone).toBe(true))),
  );

const expectWorkflowGone = (accountId: string, workflowName: string) =>
  workflows.getWorkflow({ accountId, workflowName }).pipe(
    Effect.as(false),
    Effect.catchTag("WorkflowNotFound", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: Boolean,
      times: 10,
    }),
    Effect.tap((gone) => Effect.sync(() => expect(gone).toBe(true))),
  );

const deployWith = (
  stack: Test.ScratchStack,
  triggers: (
    workflow: Cloudflare.Workflows.WorkflowBinding,
  ) => Cloudflare.Workers.EventTriggerInput[],
) =>
  stack.deploy(
    Effect.gen(function* () {
      const worker = yield* Cloudflare.Worker("event-triggers-worker", {
        main,
        env: {
          PUSHES: Cloudflare.Workflow("PushWorkflow", {
            className: "PushWorkflow",
          }),
        },
      });
      const eventTriggers = yield* Cloudflare.Workers.EventTriggers(
        "EventTriggers",
        {
          scriptName: worker.workerName,
          triggers: triggers(worker.env.PUSHES),
        },
      );
      return {
        scriptName: worker.workerName,
        workflowName: worker.env.PUSHES.workflowName,
        triggers: eventTriggers.triggers,
      };
    }),
  );

test.provider(
  "routes Artifacts events to a Workflow, updates the filter, and clears on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;

      const created = yield* deployWith(stack, (workflow) => [
        {
          type: "cf.artifacts.repo.pushed",
          filter: { namespace: "alchemy-event-triggers" },
          workflows: [workflow],
        },
      ]);
      expect(created.triggers).toEqual([
        {
          type: "cf.artifacts.repo.pushed",
          filter: { namespace: "alchemy-event-triggers" },
          workflows: [created.workflowName],
        },
      ]);
      expect(yield* storedTriggers(accountId, created.scriptName)).toEqual([
        {
          type: "cf.artifacts.repo.pushed",
          filter: { namespace: "alchemy-event-triggers" },
          targets: [
            {
              type: "workflow",
              workflowName: created.workflowName,
              scriptName: created.scriptName,
            },
          ],
        },
      ]);

      // One repository, plus a second event type: the list is replaced in place.
      yield* deployWith(stack, (workflow) => [
        {
          type: "cf.artifacts.repo.pushed",
          filter: { namespace: "alchemy-event-triggers", repoName: "app" },
          workflows: [workflow],
        },
        { type: "cf.artifacts.repo.forked", workflows: [workflow] },
      ]);
      // Cloudflare keeps its own order, and stores an omitted filter as `{}`.
      const updated = yield* storedTriggers(accountId, created.scriptName);
      expect(
        updated
          .map((trigger) => [trigger.type, trigger.filter ?? {}] as const)
          .toSorted(([a], [b]) => a.localeCompare(b)),
      ).toEqual([
        ["cf.artifacts.repo.forked", {}],
        [
          "cf.artifacts.repo.pushed",
          { namespace: "alchemy-event-triggers", repoName: "app" },
        ],
      ]);

      // An unchanged redeploy is a no-op against the observed list.
      const again = yield* deployWith(stack, (workflow) => [
        {
          type: "cf.artifacts.repo.pushed",
          filter: { namespace: "alchemy-event-triggers", repoName: "app" },
          workflows: [workflow],
        },
        { type: "cf.artifacts.repo.forked", workflows: [workflow] },
      ]);
      expect(again.triggers).toHaveLength(2);

      yield* stack.destroy();
      expect(yield* storedTriggers(accountId, created.scriptName)).toEqual([]);
      yield* expectWorkerGone(accountId, created.scriptName);
      yield* expectWorkflowGone(accountId, created.workflowName);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "an empty list clears the script's triggers and keeps the resource",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;

      const created = yield* deployWith(stack, (workflow) => [
        { type: "cf.artifacts.repo.pushed", workflows: [workflow] },
      ]);
      expect(yield* storedTriggers(accountId, created.scriptName)).toHaveLength(
        1,
      );

      const cleared = yield* deployWith(stack, () => []);
      expect(cleared.triggers).toEqual([]);
      expect(yield* storedTriggers(accountId, created.scriptName)).toEqual([]);

      yield* stack.destroy();
      yield* expectWorkerGone(accountId, created.scriptName);
    }),
  { tags, timeout: 120_000 },
);
