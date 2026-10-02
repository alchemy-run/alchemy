import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  baseWorkspace,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getHost = (
  resourceGroupName: string,
  workspaceName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* ml.GetCapabilityHost({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      name,
    });
  });

const program = Effect.gen(function* () {
  const base = yield* baseWorkspace();
  // Hub-level Agents host with Microsoft-managed storage (no connections).
  const host = yield* Azure.MachineLearning.CapabilityHost("Agents", {
    resourceGroup: base.group.resourceGroupName,
    workspace: base.workspace.workspaceName,
    description: "agents",
  });
  return { ...base, host };
});

// A capability host without bring-your-own connections provisions nothing
// billable; ~4-6 minutes. The service rejects updates (every change
// replaces) and allows one host per workspace, so replacement is not
// exercised.
test.provider(
  "create and delete a capability host",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, host } = yield* stack.deploy(program);
      const get = (name: string) =>
        getHost(group.resourceGroupName, workspace.workspaceName, name);
      expect(host.capabilityHostKind).toEqual("Agents");
      const observed = yield* get(host.capabilityHostName);
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.capabilityHostKind).toEqual("Agents");

      yield* stack.destroy();
      expect(yield* waitGone(get(host.capabilityHostName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
