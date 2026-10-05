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

const getEndpoint = (
  resourceGroupName: string,
  serverName: string,
  jobAgentName: string,
  privateEndpointName: string,
) =>
  Effect.gen(function* () {
    return yield* sql.GetJobPrivateEndpoint({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
      jobAgentName,
      privateEndpointName,
    });
  });

const program = (password: Redacted.Redacted<string>, name?: string) =>
  Effect.gen(function* () {
    const parent = yield* jobAgent(password);
    const target = yield* Azure.Sql.Server("Target", {
      resourceGroup: parent.group.resourceGroupName,
      location: parent.group.location,
      administratorLogin: "alchemyadmin",
      administratorLoginPassword: password,
    });
    const endpoint = yield* Azure.Sql.JobPrivateEndpoint("Endpoint", {
      ...parent.scope,
      name,
      targetServerId: target.serverId,
    });
    // The agent's managed private endpoint stays pending (and the agent busy)
    // until the target server approves the connection.
    const approval = yield* Azure.Sql.PrivateEndpointConnection("Approval", {
      resourceGroup: parent.group.resourceGroupName,
      server: target.serverName,
      privateEndpointId: endpoint.privateEndpointId.as<string>(),
      status: "Approved",
    });
    return { ...parent, target, endpoint, approval };
  });

// Needs an elastic job agent: S1 job database (~$0.04/hour) + JA100 (~$0.03/hour),
// about $0.10 per run, but agent creation takes 20+ minutes on the trial, so
// this only runs with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, replace, and delete an elastic job private endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(program(password));
      const get = (name: string) =>
        getEndpoint(
          first.group.resourceGroupName,
          first.server.serverName,
          first.agent.jobAgentName,
          name,
        );
      const observed = yield* get(first.endpoint.privateEndpointName);
      expect(
        observed.properties?.targetServerAzureResourceId?.toLowerCase(),
      ).toEqual(first.target.serverId.toLowerCase());

      // Renaming replaces the endpoint.
      const second = yield* stack.deploy(program(password, "alchemy-renamed"));
      expect(second.endpoint.privateEndpointName).toEqual("alchemy-renamed");
      expect(yield* awaitGone(get(first.endpoint.privateEndpointName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* awaitGone(get("alchemy-renamed"))).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 3_600_000 },
);
