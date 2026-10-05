import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { randomUUID } from "node:crypto";
import { runExpensive } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getAgent = (
  resourceGroupName: string,
  serverName: string,
  jobAgentName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* sql.GetJobAgent({
      subscriptionId,
      resourceGroupName,
      serverName,
      jobAgentName,
    });
  });

const agentGone = (
  resourceGroupName: string,
  serverName: string,
  jobAgentName: string,
) =>
  getAgent(resourceGroupName, serverName, jobAgentName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (props: {
  password: Redacted.Redacted<string>;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    // The free trial refuses new SQL servers in eastus (`ProvisioningDisabled`).
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "centralus",
    });
    const server = yield* Azure.Sql.Server("Db", {
      resourceGroup: group.resourceGroupName,
      location: group.location,
      administratorLogin: "alchemyadmin",
      administratorLoginPassword: props.password,
    });
    // Elastic jobs require an S1+ (or vCore) job database.
    const jobsDb = yield* Azure.Sql.Database("Jobs", {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      sku: { name: "S1" },
      requestedBackupStorageRedundancy: "Local",
    });
    const agent = yield* Azure.Sql.JobAgent("Agent", {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      databaseId: jobsDb.databaseId,
      sku: { name: "JA100" },
      tags: props.tags,
    });
    return { group, server, jobsDb, agent };
  });

// S1 job database (~$0.04/hour) + JA100 agent (~$0.03/hour): about $0.10
// per run, but agent creation took 20+ minutes on the trial subscription,
// past the ~10 minute budget, so the lifecycle only runs with
// AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete an elastic job agent",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = Redacted.make(
        `Az!${yield* Effect.sync(() => randomUUID())}`,
      );

      const { group, server, jobsDb, agent } = yield* stack.deploy(
        program({ password, tags: { env: "test" } }),
      );
      expect(agent.state).toEqual("Ready");
      expect(agent.databaseId.toLowerCase()).toEqual(
        jobsDb.databaseId.toLowerCase(),
      );
      const observed = yield* getAgent(
        group.resourceGroupName,
        server.serverName,
        agent.jobAgentName,
      );
      expect(observed.sku?.name).toEqual("JA100");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Agent");

      // In place: tags.
      const updated = yield* stack.deploy(
        program({ password, tags: { env: "prod" } }),
      );
      expect(updated.agent.jobAgentId).toEqual(agent.jobAgentId);
      const reobserved = yield* getAgent(
        group.resourceGroupName,
        server.serverName,
        agent.jobAgentName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* agentGone(
          group.resourceGroupName,
          server.serverName,
          agent.jobAgentName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:sql", "live"],
    timeout: 3_600_000,
  },
);
