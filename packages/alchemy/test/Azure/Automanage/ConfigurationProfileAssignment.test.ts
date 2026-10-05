import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as automanage from "@distilled.cloud/azure/automanage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly, withVcpus } from "../gates.ts";
import {
  PUBLIC_KEY_1,
  VM_LOCATION,
  VM_SIZE,
  vmNetwork,
} from "../Compute/helpers.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const DEV_TEST =
  "/providers/Microsoft.Automanage/bestPractices/AzureBestPracticesDevTest";

const getAssignment = (resourceGroupName: string, vmName: string) =>
  Effect.gen(function* () {
    return yield* automanage.GetConfigurationProfileAssignment({
      subscriptionId: yield* subscription,
      resourceGroupName,
      vmName,
      configurationProfileAssignmentName: "default",
    });
  });

const vmProgram = Effect.gen(function* () {
  const { group, nic } = yield* vmNetwork();
  const vm = yield* Azure.Compute.VirtualMachine("Vm", {
    resourceGroup: group.resourceGroupName,
    location: VM_LOCATION,
    vmSize: VM_SIZE,
    networkInterfaceIds: [nic.networkInterfaceId],
    adminUsername: "azureuser",
    sshPublicKeys: [PUBLIC_KEY_1],
  });
  return { group, vm };
});

const program = (props: { useCustomProfile: boolean }) =>
  Effect.gen(function* () {
    const { group, vm } = yield* vmProgram;
    // The custom profile stays deployed across both steps.
    const profile = yield* Azure.Automanage.ConfigurationProfile("Profile", {
      resourceGroup: group.resourceGroupName,
      location: VM_LOCATION,
      configuration: {
        "AzureSecurityBaseline/Enable": false,
        "Antimalware/Enable": false,
        "Backup/Enable": false,
        "LogAnalytics/Enable": false,
        "BootDiagnostics/Enable": true,
      },
    });
    const assignment = yield* Azure.Automanage.ConfigurationProfileAssignment(
      "Assignment",
      {
        resourceGroup: group.resourceGroupName,
        virtualMachine: vm.virtualMachineName,
        configurationProfile: props.useCustomProfile
          ? profile.configurationProfileId
          : DEV_TEST,
      },
    );
    return { group, vm, profile, assignment };
  });

// One 1-vCPU VM (~$0.02/hour) for ~10-15 minutes. Automanage is retiring and
// closed to new subscriptions (pay-as-you-go included), so profiles and
// assignments fail
// (`AutomanageSubscriptionNotSupported`, 400 InvalidSubscriptionState), and
// onboarding with best-practice profiles provisions Log Analytics /
// Automation resources in default resource groups. Runs with
// AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a configuration profile assignment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vm, profile, assignment } = yield* stack.deploy(
        program({ useCustomProfile: true }),
      );
      expect(assignment.configurationProfile.toLowerCase()).toEqual(
        profile.configurationProfileId.toLowerCase(),
      );
      const observed = yield* getAssignment(
        group.resourceGroupName,
        vm.virtualMachineName,
      );
      expect(observed.properties?.configurationProfile?.toLowerCase()).toEqual(
        profile.configurationProfileId.toLowerCase(),
      );
      expect(observed.properties?.targetId?.toLowerCase()).toEqual(
        vm.virtualMachineId.toLowerCase(),
      );

      // In place: switch to the built-in dev/test best practices.
      const updated = yield* stack.deploy(program({ useCustomProfile: false }));
      expect(updated.assignment.assignmentId).toEqual(assignment.assignmentId);
      const reobserved = yield* getAssignment(
        group.resourceGroupName,
        vm.virtualMachineName,
      );
      expect(
        reobserved.properties?.configurationProfile?.toLowerCase(),
      ).toEqual(DEV_TEST.toLowerCase());

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getAssignment(group.resourceGroupName, vm.virtualMachineName),
        ),
      ).toEqual("gone");
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: one 1-vCPU VM (~$0.02/hour) for ~5 minutes.
// A non-onboarded subscription rejects assignments with the typed
// subscription-state error.
test.provider(
  "a non-onboarded subscription rejects profile assignments with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vm } = yield* stack.deploy(vmProgram);
      const error = yield* automanage
        .ConfigurationProfileAssignmentsCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          vmName: vm.virtualMachineName,
          configurationProfileAssignmentName: "default",
          properties: { configurationProfile: DEV_TEST },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("AutomanageSubscriptionNotSupported");
      expect(
        yield* waitGone(
          getAssignment(group.resourceGroupName, vm.virtualMachineName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 900_000 },
);
