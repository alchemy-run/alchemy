import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as guestconfiguration from "@distilled.cloud/azure/guestconfiguration";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { withVcpus } from "../gates.ts";
import {
  logLevel,
  PUBLIC_KEY,
  subscription,
  tags,
  VM_LOCATION,
  VM_SIZE,
  vmNetwork,
  waitAbsent,
  whileLookupFails,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

// Observed through the list: GET intermittently fails with
// GuestConfigurationMachineLookupFailed for minutes after VM creation.
const getAssignment = (
  resourceGroupName: string,
  vmName: string,
  name: string,
) =>
  Effect.gen(function* () {
    const page = yield* guestconfiguration
      .ListGuestConfigurationAssignments({
        subscriptionId: yield* subscription,
        resourceGroupName,
        vmName,
      })
      .pipe(
        Effect.retry(whileLookupFails),
        Effect.catchTag(
          ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
          () => Effect.succeed({ value: [] }),
        ),
      );
    return (page.value ?? []).find((a) => a.name === name);
  });

const program = (props: {
  configurationName: string;
  assignmentType: Azure.GuestConfiguration.AssignmentType;
  parameters?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, nic } = yield* vmNetwork("alchemy-gc-vm-assignment");
    const vm = yield* Azure.Compute.VirtualMachine("Vm", {
      resourceGroup: group.resourceGroupName,
      name: "gc-vm",
      location: VM_LOCATION,
      vmSize: VM_SIZE,
      networkInterfaceIds: [nic.networkInterfaceId],
      adminUsername: "azureuser",
      sshPublicKeys: [PUBLIC_KEY],
      identity: { systemAssigned: true },
    });
    const assignment = yield* Azure.GuestConfiguration.VirtualMachineAssignment(
      "Baseline",
      {
        resourceGroup: group.resourceGroupName,
        virtualMachine: vm.virtualMachineName,
        configurationName: props.configurationName,
        configurationVersion: "1.*",
        assignmentType: props.assignmentType,
        parameters: props.parameters,
      },
    );
    return { group, vm, assignment };
  });

// One 1-vCPU VM (~$0.04/hour) for ~10 minutes; assignments are free.
test.provider(
  "create, update, replace, and delete a VM guest configuration assignment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vm, assignment } = yield* stack.deploy(
        program({
          configurationName: "AzureLinuxBaseline",
          assignmentType: "Audit",
        }),
      );
      const rg = group.resourceGroupName;
      const vmName = vm.virtualMachineName;
      expect(assignment.assignmentName).toEqual("AzureLinuxBaseline");
      expect(assignment.virtualMachine).toEqual(vmName);
      expect(assignment.location.toLowerCase()).toEqual(
        vm.location.toLowerCase(),
      );
      const observed = yield* getAssignment(rg, vmName, "AzureLinuxBaseline");
      expect(observed?.properties?.guestConfiguration?.name).toEqual(
        "AzureLinuxBaseline",
      );
      expect(observed?.properties?.guestConfiguration?.assignmentType).toEqual(
        "Audit",
      );

      // In place: assignment type.
      const updated = yield* stack.deploy(
        program({
          configurationName: "AzureLinuxBaseline",
          assignmentType: "ApplyAndMonitor",
        }),
      );
      expect(updated.assignment.assignmentId).toEqual(assignment.assignmentId);
      const reobserved = yield* getAssignment(rg, vmName, "AzureLinuxBaseline");
      expect(
        reobserved?.properties?.guestConfiguration?.assignmentType,
      ).toEqual("ApplyAndMonitor");

      // Replacement: another configuration package.
      const replaced = yield* stack.deploy(
        program({
          configurationName: "LinuxSshServerSecurityBaseline",
          assignmentType: "Audit",
        }),
      );
      expect(replaced.assignment.assignmentName).toEqual(
        "LinuxSshServerSecurityBaseline",
      );
      expect(
        yield* waitAbsent(getAssignment(rg, vmName, "AzureLinuxBaseline")),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitAbsent(
          getAssignment(rg, vmName, "LinuxSshServerSecurityBaseline"),
        ),
      ).toEqual("gone");
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 900_000 },
);
