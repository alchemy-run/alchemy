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
  name: string,
) =>
  Effect.gen(function* () {
    return yield* sql.GetJob({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
      jobAgentName,
      jobName: name,
    });
  });

type Step = { name?: string; description: string };

const program = (password: Redacted.Redacted<string>, step: Step) =>
  Effect.gen(function* () {
    const parent = yield* jobAgent(password);
    const child = yield* Azure.Sql.Job("Child", {
      ...parent.scope,
      name: step.name,
      description: step.description,
      schedule: { type: "Recurring", interval: "PT1H", enabled: false },
    });
    return { ...parent, child };
  });

// Needs an elastic job agent: S1 job database (~$0.04/hour) + JA100 (~$0.03/hour),
// about $0.10 per run, but agent creation takes 20+ minutes on the trial, so
// this only runs with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete an elastic job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, { description: "first" }),
      );
      const get = (name: string) =>
        getChild(
          first.group.resourceGroupName,
          first.server.serverName,
          first.agent.jobAgentName,
          name,
        );
      const observed1 = yield* get(first.child.jobName);
      expect(observed1.properties?.description).toEqual("first");
      expect(observed1.properties?.schedule?.interval).toEqual("PT1H");

      // In place update.
      const second = yield* stack.deploy(
        program(password, { description: "second" }),
      );
      expect(second.child.jobId).toEqual(first.child.jobId);
      const observed2 = yield* get(first.child.jobName);
      expect(observed2.properties?.description).toEqual("second");

      // Renaming replaces the job.
      const third = yield* stack.deploy(
        program(password, {
          ...{ description: "second" },
          name: "alchemy-renamed",
        }),
      );
      expect(third.child.jobName).toEqual("alchemy-renamed");
      expect(yield* awaitGone(get(first.child.jobName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* awaitGone(get("alchemy-renamed"))).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 900_000 },
);
