import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hybridcompute from "@distilled.cloud/azure/hybridcompute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  connectedMachine,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const [resourceGroup = "", machineName = ""] = connectedMachine ?? [];

const getRunCommand = (runCommandName: string) =>
  Effect.gen(function* () {
    return yield* hybridcompute.GetMachineRunCommand({
      subscriptionId: yield* subscription,
      resourceGroupName: resourceGroup,
      machineName,
      runCommandName,
    });
  });

const program = (props: { name?: string; greeting: string }) =>
  Azure.HybridCompute.MachineRunCommand("Command", {
    resourceGroup,
    machineName,
    name: props.name,
    script: "echo $GREETING",
    parameters: [{ name: "GREETING", value: props.greeting }],
    timeoutInSeconds: 120,
  }).pipe(Effect.map((command) => ({ command })));

// Run commands execute through the Connected Machine agent, so this needs
// a connected Linux Arc server (AZURE_TEST_ARC_MACHINE=<rg>/<machine>);
// the free trial has none. On a pre-registered (unconnected) machine the
// PUT is accepted but the command disappears.
test.provider.skipIf(!runPaidOnly || connectedMachine === undefined)(
  "run, re-run, replace, and delete a machine run command",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { command } = yield* stack.deploy(program({ greeting: "hello" }));
      expect(command.executionState).toEqual("Succeeded");
      expect(command.output).toContain("hello");

      // In-place: a new parameter re-runs the script.
      const updated = yield* stack.deploy(program({ greeting: "again" }));
      expect(updated.command.runCommandId).toEqual(command.runCommandId);
      expect(updated.command.output).toContain("again");
      const observed = yield* getRunCommand(command.runCommandName);
      expect(observed.properties?.parameters?.[0]?.value).toEqual("again");

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-test-run-b", greeting: "again" }),
      );
      expect(replaced.command.runCommandName).toEqual("alchemy-test-run-b");
      expect(yield* waitGone(getRunCommand(command.runCommandName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* waitGone(getRunCommand("alchemy-test-run-b"))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
