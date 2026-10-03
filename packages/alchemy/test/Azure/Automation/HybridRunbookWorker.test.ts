import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as automation from "@distilled.cloud/azure/automation";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { withVcpus } from "../gates.ts";
import { PUBLIC_KEY_1, VM_LOCATION, VM_SIZE } from "../Compute/helpers.ts";
import {
  account,
  logLevel,
  sharedAccountTest,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = Effect.gen(function* () {
  const { group, where } = yield* account;
  const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
    resourceGroup: group.resourceGroupName,
    location: VM_LOCATION,
    addressPrefixes: ["10.0.0.0/16"],
  });
  const subnet = yield* Azure.Network.Subnet("Vms", {
    resourceGroup: group.resourceGroupName,
    virtualNetwork: vnet.virtualNetworkName,
    addressPrefix: "10.0.1.0/24",
  });
  const nic = yield* Azure.Network.NetworkInterface("Nic", {
    resourceGroup: group.resourceGroupName,
    location: VM_LOCATION,
    ipConfigurations: [{ subnetId: subnet.subnetId }],
  });
  const vm = yield* Azure.Compute.VirtualMachine("Vm", {
    resourceGroup: group.resourceGroupName,
    location: VM_LOCATION,
    vmSize: VM_SIZE,
    networkInterfaceIds: [nic.networkInterfaceId],
    adminUsername: "azureuser",
    sshPublicKeys: [PUBLIC_KEY_1],
  });
  const workers = yield* Azure.Automation.HybridRunbookWorkerGroup(
    "Workers",
    where,
  );
  const worker = yield* Azure.Automation.HybridRunbookWorker("Worker", {
    ...where,
    hybridRunbookWorkerGroup: workers.hybridRunbookWorkerGroupName,
    vmResourceId: vm.virtualMachineId,
  });
  return { where, workers, vm, worker };
});

const getWorker = (
  resourceGroupName: string,
  automationAccountName: string,
  hybridRunbookWorkerGroupName: string,
  hybridRunbookWorkerId: string,
) =>
  Effect.gen(function* () {
    return yield* automation.GetHybridRunbookWorker({
      subscriptionId: yield* subscription,
      resourceGroupName,
      automationAccountName,
      hybridRunbookWorkerGroupName,
      hybridRunbookWorkerId,
    });
  });

// One 1-vCPU VM (~$0.04/hour) for ~2-5 minutes; the registration itself is
// free. Only the registration is exercised: making the VM an online worker
// also needs the HybridWorkerForLinux extension (and its prerequisites),
// which belongs to the Compute provider. Every prop is immutable, so a
// replacement would need a second VM (and vCPU) for no extra coverage.
test.provider(
  "register and delete a hybrid runbook worker",
  (stack) =>
    sharedAccountTest(stack)(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { where, workers, vm, worker } = yield* stack.deploy(program);
        const get = (id: string) =>
          getWorker(
            where.resourceGroup,
            where.automationAccount,
            workers.hybridRunbookWorkerGroupName,
            id,
          );
        expect(worker.vmResourceId?.toLowerCase()).toEqual(
          vm.virtualMachineId.toLowerCase(),
        );
        const observed = yield* get(worker.hybridRunbookWorkerId);
        expect(observed.properties?.vmResourceId?.toLowerCase()).toEqual(
          vm.virtualMachineId.toLowerCase(),
        );

        yield* stack.destroy();
        expect(yield* waitGone(get(worker.hybridRunbookWorkerId))).toEqual(
          "gone",
        );
      }),
    ).pipe(withVcpus(1), logLevel),
  { tags, timeout: 900_000 },
);
