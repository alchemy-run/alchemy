import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { runExpensive } from "../gates.ts";
import { jobAgent } from "./jobs.ts";
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
  jobAgentName: string,
  jobName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* sql.GetJobStep({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
      jobAgentName,
      jobName,
      stepName: name,
    });
  });

type Step = { name?: string; script: string };

const program = (password: Redacted.Redacted<string>, step: Step) =>
  Effect.gen(function* () {
    const agent = yield* jobAgent(password);
    const targets = yield* Azure.Sql.JobTargetGroup("Targets", {
      ...agent.scope,
      members: [
        {
          type: "SqlDatabase",
          serverName: agent.server.fullyQualifiedDomainName,
          databaseName: agent.jobsDb.databaseName,
        },
      ],
    });
    const job = yield* Azure.Sql.Job("Job", {
      ...agent.scope,
      description: "alchemy job step test",
    });
    const parent = { ...agent, targets, job };
    const child = yield* Azure.Sql.JobStep("Child", {
      ...parent.scope,
      job: job.jobName,
      name: step.name,
      targetGroup: targets.targetGroupId,
      script: step.script,
    });
    return { ...parent, child };
  });

// Needs an elastic job agent: S1 job database (~$0.04/hour) + JA100 (~$0.03/hour),
// about $0.10 per run, but agent creation takes 20+ minutes on the trial, so
// this only runs with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete an elastic job step",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, { script: "SELECT 1;" }),
      );
      const get = (name: string) =>
        getChild(
          first.group.resourceGroupName,
          first.server.serverName,
          first.agent.jobAgentName,
          first.job.jobName,
          name,
        );
      const observed1 = yield* get(first.child.stepName);
      expect(observed1.properties?.action.value).toEqual("SELECT 1;");

      // In place update.
      const second = yield* stack.deploy(
        program(password, { script: "SELECT 2;" }),
      );
      expect(second.child.stepId).toEqual(first.child.stepId);
      const observed2 = yield* get(first.child.stepName);
      expect(observed2.properties?.action.value).toEqual("SELECT 2;");

      // Renaming replaces the step.
      const third = yield* stack.deploy(
        program(password, {
          ...{ script: "SELECT 2;" },
          name: "alchemy-renamed",
        }),
      );
      expect(third.child.stepName).toEqual("alchemy-renamed");
      expect(yield* awaitGone(get(first.child.stepName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* awaitGone(get("alchemy-renamed"))).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 3_600_000 },
);
