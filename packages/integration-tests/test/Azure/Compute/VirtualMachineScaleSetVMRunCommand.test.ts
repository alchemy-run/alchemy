import * as Azure from "@alchemy.run/azure";
import * as compute from "@distilled.cloud/azure/compute";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { withVcpus } from "../gates.ts";
import { logLevel, subscriptionId, tags, uniformScaleSet, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRunCommand = (resourceGroupName: string, vmScaleSetName: string, runCommandName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetVirtualMachineScaleSetVMRunCommand({
      subscriptionId,
      resourceGroupName,
      vmScaleSetName,
      instanceId: "0",
      runCommandName,
      _expand: "instanceView",
    }),
  );

// One 1-vCPU scale set instance (~$0.04/hour) for ~15 minutes; run
// commands are free.
const program = (props: { greeting: string; secret: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const { group, scaleSet } = yield* uniformScaleSet;
    const command = yield* Azure.Compute.VirtualMachineScaleSetVMRunCommand("Hello", {
      resourceGroup: group.resourceGroupName,
      virtualMachineScaleSet: scaleSet.virtualMachineScaleSetName,
      instanceId: "0",
      script: 'echo "$GREETING ${#SECRET}"',
      parameters: { GREETING: props.greeting },
      protectedParameters: Redacted.make({ SECRET: props.secret }),
      tags: props.tags,
    });
    return { group, scaleSet, command };
  });

test.provider(
  "create, re-run, replace, and delete a scale set VM run command",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, scaleSet, command } = yield* stack.deploy(
        program({ greeting: "hello", secret: "abc", tags: { env: "test" } }),
      );
      expect(scaleSet.instanceIds).toEqual(["0"]);
      expect(command.provisioningState).toEqual("Succeeded");
      expect(command.exitCode).toEqual(0);
      expect(command.output).toContain("hello 3");
      const setName = scaleSet.virtualMachineScaleSetName;
      const observed = yield* getRunCommand(
        group.resourceGroupName,
        setName,
        command.runCommandName,
      );
      expect(observed.properties?.instanceView?.executionState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Hello");

      // In place: a new parameter and secret re-run the script.
      const updated = yield* stack.deploy(
        program({ greeting: "bonjour", secret: "abcde", tags: { env: "test" } }),
      );
      expect(updated.command.runCommandId).toEqual(command.runCommandId);
      expect(updated.command.output).toContain("bonjour 5");

      // Replace: Azure does not update tags in place. The replacement gets
      // a new name, runs again, and the old run command is deleted.
      const retagged = yield* stack.deploy(
        program({ greeting: "bonjour", secret: "abcde", tags: { env: "prod" } }),
      );
      const newName = retagged.command.runCommandName;
      expect(newName).not.toEqual(command.runCommandName);
      expect(retagged.command.tags).toEqual({ env: "prod" });
      expect(retagged.command.output).toContain("bonjour 5");
      const reobserved = yield* getRunCommand(group.resourceGroupName, setName, newName);
      expect(reobserved.tags?.env).toEqual("prod");
      expect(
        yield* untilGone(getRunCommand(group.resourceGroupName, setName, command.runCommandName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(yield* untilGone(getRunCommand(group.resourceGroupName, setName, newName))).toEqual(
        "gone",
      );
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 900_000 },
);
