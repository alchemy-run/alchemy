import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as serialconsole from "@distilled.cloud/azure/serialconsole";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  PUBLIC_KEY_1,
  subscriptionId,
  untilGone,
  VM_LOCATION,
  VM_SIZE,
  vmNetwork,
} from "../Compute/helpers.ts";
import { withVcpus } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const tags = ["provider:azure", "provider:azure:serialconsole", "live"];

const getPort = (resourceGroupName: string, vmName: string, port: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    serialconsole.GetSerialPort({
      subscriptionId,
      resourceGroupName,
      resourceProviderNamespace: "Microsoft.Compute",
      parentResourceType: "virtualMachines",
      parentResource: vmName,
      serialPort: port,
    }),
  );

// One 1-vCPU VM (~$0.04/hour) for ~10 minutes; the serial port is free.
const program = (port: { state: "enabled" | "disabled" } | undefined) =>
  Effect.gen(function* () {
    const { group, nic } = yield* vmNetwork();
    const vm = yield* Azure.Compute.VirtualMachine("Vm", {
      resourceGroup: group.resourceGroupName,
      location: VM_LOCATION,
      vmSize: VM_SIZE,
      networkInterfaceIds: [nic.networkInterfaceId],
      adminUsername: "azureuser",
      sshPublicKeys: [PUBLIC_KEY_1],
      bootDiagnostics: true,
    });
    const serialPort =
      port === undefined
        ? undefined
        : yield* Azure.SerialConsole.SerialPort("Console", {
            resourceGroup: group.resourceGroupName,
            virtualMachine: vm.virtualMachineName,
            state: port.state,
          });
    return { group, vm, serialPort };
  });

test.provider(
  "create, update, and delete a VM serial port",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vm, serialPort } = yield* stack.deploy(
        program({ state: "enabled" }),
      );
      expect(serialPort?.serialPortName).toEqual("0");
      expect(serialPort?.state).toEqual("enabled");
      const observed = yield* getPort(
        group.resourceGroupName,
        vm.virtualMachineName,
        "0",
      );
      expect(observed.properties?.state).toEqual("enabled");
      expect(observed.id?.toLowerCase()).toContain(
        "/providers/microsoft.serialconsole/serialports/0",
      );

      // In place: disable the port.
      const updated = yield* stack.deploy(program({ state: "disabled" }));
      expect(updated.serialPort?.serialPortId).toEqual(
        serialPort?.serialPortId,
      );
      expect(updated.serialPort?.state).toEqual("disabled");
      const reobserved = yield* getPort(
        group.resourceGroupName,
        vm.virtualMachineName,
        "0",
      );
      expect(reobserved.properties?.state).toEqual("disabled");

      // Removing the resource while the VM stays resets port 0 to its
      // default (`enabled`); the port itself always exists on a VM.
      yield* stack.deploy(program(undefined));
      const reset = yield* getPort(
        group.resourceGroupName,
        vm.virtualMachineName,
        "0",
      );
      expect(reset.properties?.state).toEqual("enabled");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getPort(group.resourceGroupName, vm.virtualMachineName, "0"),
        ),
      ).toEqual("gone");
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 900_000 },
);
