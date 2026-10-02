import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/azure/compute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { withVcpus } from "../gates.ts";
import {
  logLevel,
  PUBLIC_KEY_1,
  subscriptionId,
  tags,
  untilGone,
  VM_LOCATION,
  VM_SIZE,
  vmNetwork,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRunCommand = (
  resourceGroupName: string,
  vmName: string,
  runCommandName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetVirtualMachineRunCommandByVirtualMachine({
      subscriptionId,
      resourceGroupName,
      vmName,
      runCommandName,
      _expand: "instanceView",
    }),
  );

// One 1-vCPU VM (~$0.04/hour) for ~10 minutes; run commands are free.
const program = (props: {
  greeting: string;
  secret: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, nic } = yield* vmNetwork();
    const vm = yield* Azure.Compute.VirtualMachine("Vm", {
      resourceGroup: group.resourceGroupName,
      location: VM_LOCATION,
      vmSize: VM_SIZE,
      networkInterfaceIds: [nic.networkInterfaceId],
      adminUsername: "azureuser",
      sshPublicKeys: [PUBLIC_KEY_1],
    });
    const command = yield* Azure.Compute.VirtualMachineRunCommand("Hello", {
      resourceGroup: group.resourceGroupName,
      virtualMachine: vm.virtualMachineName,
      script: 'echo "$GREETING ${#SECRET}"',
      parameters: { GREETING: props.greeting },
      protectedParameters: Redacted.make({ SECRET: props.secret }),
      tags: props.tags,
    });
    return { group, vm, command };
  });

test.provider(
  "create, re-run, and delete a VM run command",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vm, command } = yield* stack.deploy(
        program({ greeting: "hello", secret: "abc", tags: { env: "test" } }),
      );
      expect(command.provisioningState).toEqual("Succeeded");
      expect(command.exitCode).toEqual(0);
      expect(command.output).toContain("hello 3");
      const observed = yield* getRunCommand(
        group.resourceGroupName,
        vm.virtualMachineName,
        command.runCommandName,
      );
      expect(observed.properties?.instanceView?.executionState).toEqual(
        "Succeeded",
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Hello");

      // In place: new parameter and secret re-run the script; new tags.
      const updated = yield* stack.deploy(
        program({
          greeting: "bonjour",
          secret: "abcde",
          tags: { env: "prod" },
        }),
      );
      expect(updated.command.runCommandId).toEqual(command.runCommandId);
      expect(updated.command.output).toContain("bonjour 5");
      const reobserved = yield* getRunCommand(
        group.resourceGroupName,
        vm.virtualMachineName,
        command.runCommandName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getRunCommand(
            group.resourceGroupName,
            vm.virtualMachineName,
            command.runCommandName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 900_000 },
);
