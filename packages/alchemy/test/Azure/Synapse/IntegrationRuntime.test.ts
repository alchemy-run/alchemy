import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as synapse from "@distilled.cloud/azure/synapse";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  lakeWorkspace,
  logLevel,
  untilGone,
  withWorkspaceSlot,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRuntime = (
  resourceGroupName: string,
  workspaceName: string,
  integrationRuntimeName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* synapse.GetIntegrationRuntime({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      integrationRuntimeName,
    });
  });

/** Data flow core count from a Managed runtime's untyped `typeProperties`. */
const coreCount = (typeProperties: unknown) =>
  (
    typeProperties as
      | { computeProperties?: { dataFlowProperties?: { coreCount?: number } } }
      | undefined
  )?.computeProperties?.dataFlowProperties?.coreCount;

const program = (props: {
  description: string;
  coreCount: number;
  type?: "Managed" | "SelfHosted";
}) =>
  Effect.gen(function* () {
    const { group, workspace } = yield* lakeWorkspace();
    const runtime = yield* Azure.Synapse.IntegrationRuntime("Flows", {
      resourceGroup: group.resourceGroupName,
      workspace: workspace.workspaceName,
      type: props.type ?? "Managed",
      description: props.description,
      computeProperties:
        props.type === "SelfHosted"
          ? undefined
          : {
              location: "AutoResolve",
              dataFlowProperties: {
                computeType: "General",
                coreCount: props.coreCount,
                timeToLive: 10,
              },
            },
    });
    return { group, workspace, runtime };
  });

// Runtime metadata is free (Managed runtimes bill only while activities
// run); the workspace takes ~3-8 min.
test.provider(
  "create, update, replace, and delete a synapse integration runtime",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, runtime } = yield* stack.deploy(
        program({ description: "first", coreCount: 8 }),
      );
      const rg = group.resourceGroupName;
      const ws = workspace.workspaceName;
      expect(runtime.type).toEqual("Managed");
      const observed = yield* getRuntime(
        rg,
        ws,
        runtime.integrationRuntimeName,
      );
      expect(observed.properties.description).toEqual("first");
      expect(coreCount(observed.properties.typeProperties)).toEqual(8);

      // In place: description + data flow cores.
      const updated = yield* stack.deploy(
        program({ description: "second", coreCount: 16 }),
      );
      expect(updated.runtime.integrationRuntimeId).toEqual(
        runtime.integrationRuntimeId,
      );
      const reobserved = yield* getRuntime(
        rg,
        ws,
        runtime.integrationRuntimeName,
      );
      expect(reobserved.properties.description).toEqual("second");
      expect(coreCount(reobserved.properties.typeProperties)).toEqual(16);

      // Replace: Managed -> SelfHosted.
      const selfHosted = yield* stack.deploy(
        program({ description: "self", coreCount: 16, type: "SelfHosted" }),
      );
      expect(selfHosted.runtime.type).toEqual("SelfHosted");
      const shObserved = yield* getRuntime(
        rg,
        ws,
        selfHosted.runtime.integrationRuntimeName,
      );
      expect(shObserved.properties.type).toEqual("SelfHosted");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getRuntime(rg, ws, selfHosted.runtime.integrationRuntimeName),
        ),
      ).toEqual("gone");
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);
