import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as guestconfiguration from "@distilled.cloud/azure/guestconfiguration";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly, withVcpus } from "../gates.ts";
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

// The scale set list endpoint is not served (404); GET answers 200 with an
// embedded error when there is no assignment to show.
const getAssignment = (
  resourceGroupName: string,
  vmssName: string,
  name: string,
) =>
  Effect.gen(function* () {
    const assignment = yield* guestconfiguration
      .GetGuestConfigurationAssignmentsVMSS({
        subscriptionId: yield* subscription,
        resourceGroupName,
        vmssName,
        name,
      })
      .pipe(
        Effect.retry(whileLookupFails),
        Effect.catchTag(
          ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
          () => Effect.succeed(undefined),
        ),
      );
    return assignment?.error === undefined ? assignment : undefined;
  });

const program = (props: {
  configurationName: string;
  assignmentType: Azure.GuestConfiguration.AssignmentType;
  parameters?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, subnet } = yield* vmNetwork("alchemy-gc-vmss-assignment");
    const vmss = yield* Azure.Compute.VirtualMachineScaleSet("Vmss", {
      resourceGroup: group.resourceGroupName,
      name: "gc-vmss",
      capacity: 1,
      location: VM_LOCATION,
      vmSize: VM_SIZE,
      subnetId: subnet.subnetId,
      adminUsername: "azureuser",
      sshPublicKeys: [PUBLIC_KEY],
    });
    const assignment =
      yield* Azure.GuestConfiguration.VirtualMachineScaleSetAssignment(
        "Baseline",
        {
          resourceGroup: group.resourceGroupName,
          virtualMachineScaleSet: vmss.virtualMachineScaleSetName,
          configurationName: props.configurationName,
          configurationVersion: "1.*",
          assignmentType: props.assignmentType,
          parameters: props.parameters,
        },
      );
    return { group, vmss, assignment };
  });

// A Flexible scale set with one 1-vCPU instance (~$0.04/hour) for ~10
// minutes; assignments are free. Gated: the service currently answers every
// scale set assignment with an embedded `VMSSNotSupported` error (see the
// probe below), so the lifecycle cannot run on any subscription today.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a scale set guest configuration assignment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vmss, assignment } = yield* stack.deploy(
        program({
          configurationName: "AzureLinuxBaseline",
          assignmentType: "Audit",
        }),
      );
      const rg = group.resourceGroupName;
      const vmssName = vmss.virtualMachineScaleSetName;
      expect(assignment.assignmentName).toEqual("AzureLinuxBaseline");
      expect(assignment.virtualMachineScaleSet).toEqual(vmssName);
      expect(assignment.location.toLowerCase()).toEqual(
        vmss.location.toLowerCase(),
      );
      const observed = yield* getAssignment(rg, vmssName, "AzureLinuxBaseline");
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
      const reobserved = yield* getAssignment(
        rg,
        vmssName,
        "AzureLinuxBaseline",
      );
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
        yield* waitAbsent(getAssignment(rg, vmssName, "AzureLinuxBaseline")),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitAbsent(
          getAssignment(rg, vmssName, "LinuxSshServerSecurityBaseline"),
        ),
      ).toEqual("gone");
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (~$0.01, ~3 minutes): the service rejects scale set
// assignments, and the provider surfaces it as a typed error.
test.provider(
  "a scale set assignment is rejected with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* stack
        .deploy(
          program({
            configurationName: "AzureLinuxBaseline",
            assignmentType: "Audit",
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual(
        "Azure.GuestConfiguration.ScaleSetAssignmentRejected",
      );
      expect(String((error as { code?: string }).code)).toEqual(
        "VMSSNotSupported",
      );

      yield* stack.destroy();
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 900_000 },
);
