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
    return yield* sql.GetJobTargetGroup({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
      jobAgentName,
      targetGroupName: name,
    });
  });

type Step = { name?: string; exclude: boolean };

const program = (password: Redacted.Redacted<string>, step: Step) =>
  Effect.gen(function* () {
    const parent = yield* jobAgent(password);
    const serverFqdn = parent.server.fullyQualifiedDomainName;
    const child = yield* Azure.Sql.JobTargetGroup("Child", {
      ...parent.scope,
      name: step.name,
      members: [
        { type: "SqlServer", serverName: serverFqdn },
        ...(step.exclude
          ? [
              {
                membershipType: "Exclude" as const,
                type: "SqlDatabase" as const,
                serverName: serverFqdn,
                databaseName: parent.jobsDb.databaseName,
              },
            ]
          : []),
      ],
    });
    return { ...parent, child };
  });

// Needs an elastic job agent: S1 job database (~$0.04/hour) + JA100 (~$0.03/hour),
// about $0.10 per run, but agent creation takes 20+ minutes on the trial, so
// this only runs with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete an elastic job target group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(program(password, { exclude: false }));
      const get = (name: string) =>
        getChild(
          first.group.resourceGroupName,
          first.server.serverName,
          first.agent.jobAgentName,
          name,
        );
      const observed1 = yield* get(first.child.targetGroupName);
      expect(observed1.properties?.members).toHaveLength(1);

      // In place update.
      const second = yield* stack.deploy(program(password, { exclude: true }));
      expect(second.child.targetGroupId).toEqual(first.child.targetGroupId);
      const observed2 = yield* get(first.child.targetGroupName);
      expect(observed2.properties?.members).toHaveLength(2);

      // Renaming replaces the target group.
      const third = yield* stack.deploy(
        program(password, { ...{ exclude: true }, name: "alchemy-renamed" }),
      );
      expect(third.child.targetGroupName).toEqual("alchemy-renamed");
      expect(yield* awaitGone(get(first.child.targetGroupName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* awaitGone(get("alchemy-renamed"))).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 3_600_000 },
);
