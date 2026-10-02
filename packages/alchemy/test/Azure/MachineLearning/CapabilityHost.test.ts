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

const program = (props: { description: string }) =>
  Effect.gen(function* () {
    const base = yield* baseWorkspace();
    // Hub-level Agents host with Microsoft-managed storage (no connections).
    const host = yield* Azure.MachineLearning.CapabilityHost("Agents", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      description: props.description,
    });
    return { ...base, host };
  });

// A capability host without bring-your-own connections provisions nothing
// billable; ~4-8 minutes including a replacement.
test.provider(
  "create, replace, and delete a capability host",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, host } = yield* stack.deploy(
        program({ description: "v1" }),
      );
      const get = (name: string) =>
        getHost(group.resourceGroupName, workspace.workspaceName, name);
      expect(host.capabilityHostKind).toEqual("Agents");
      const observed = yield* get(host.capabilityHostName);
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.description).toEqual("v1");
      expect(observed.properties.tags?.["alchemy::id"]).toEqual("Agents");

      // Replacement: the service rejects updates, so any change replaces.
      const replaced = yield* stack.deploy(program({ description: "v2" }));
      expect(replaced.host.capabilityHostName).not.toEqual(
        host.capabilityHostName,
      );
      const replacedObserved = yield* get(replaced.host.capabilityHostName);
      expect(replacedObserved.properties.description).toEqual("v2");
      expect(yield* waitGone(get(host.capabilityHostName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.host.capabilityHostName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
