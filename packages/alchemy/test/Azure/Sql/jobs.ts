import * as Azure from "@/Azure";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { sqlServer } from "./harness.ts";

/**
 * Elastic job agents need an S1+ job database and take 20+ minutes to
 * create on the trial subscription (S1 ~$0.04/hour + JA100 ~$0.03/hour),
 * so every elastic-job child test only runs with AZURE_TEST_EXPENSIVE=1.
 */
export const jobAgent = (password: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const { group, server } = yield* sqlServer(password);
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
    });
    const scope = {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      jobAgent: agent.jobAgentName,
    };
    return { group, server, jobsDb, agent, scope };
  });
