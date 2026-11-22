import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";
import { PUBLIC_KEY_1, VM_LOCATION, VM_SIZE } from "../helpers.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations. Both land in the stack's resource group.

/** Text the run-command route echoes; the test finds it in the VM's instance view. */
export const RUN_COMMAND_TOKEN = "alchemy-run-command-binding";

const Network = Effect.gen(function* () {
  const vnet = yield* Azure.Network.VirtualNetwork("ComputeBindingsVnet", {
    location: VM_LOCATION,
    addressPrefixes: ["10.0.0.0/16"],
  });
  const subnet = yield* Azure.Network.Subnet("ComputeBindingsSubnet", {
    resourceGroup: vnet.resourceGroup,
    virtualNetwork: vnet.virtualNetworkName,
    addressPrefix: "10.0.1.0/24",
  });
  return { vnet, subnet };
});

/** 1-vCPU VM without a public IP. */
export const Vm = Effect.gen(function* () {
  const { subnet } = yield* Network;
  const nic = yield* Azure.Network.NetworkInterface("ComputeBindingsNic", {
    location: VM_LOCATION,
    ipConfigurations: [{ subnetId: subnet.subnetId }],
  });
  return yield* Azure.Compute.VirtualMachine("ComputeBindingsVm", {
    location: VM_LOCATION,
    vmSize: VM_SIZE,
    networkInterfaceIds: [nic.networkInterfaceId],
    adminUsername: "azureuser",
    sshPublicKeys: [PUBLIC_KEY_1],
  });
});

/** One-instance `Uniform` scale set (1 vCPU); its instance ID is `"0"`. */
export const ScaleSet = Effect.gen(function* () {
  const { subnet } = yield* Network;
  return yield* Azure.Compute.VirtualMachineScaleSet("ComputeBindingsVmss", {
    location: VM_LOCATION,
    orchestrationMode: "Uniform",
    vmSize: VM_SIZE,
    capacity: 1,
    subnetId: subnet.subnetId,
    adminUsername: "azureuser",
    sshPublicKeys: [PUBLIC_KEY_1],
  });
});

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Effect-native Azure Function exercising every Compute runtime-action
 * binding on a managed-identity host, one route per binding.
 */
export default class ComputeFunction extends Azure.Functions.Function<ComputeFunction>()(
  "ComputeBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const vm = yield* Vm;
    const scaleSet = yield* ScaleSet;
    const startVm = yield* Azure.Compute.StartVirtualMachine(vm);
    const powerOffVm = yield* Azure.Compute.PowerOffVirtualMachine(vm);
    const deallocateVm = yield* Azure.Compute.DeallocateVirtualMachine(vm);
    const restartVm = yield* Azure.Compute.RestartVirtualMachine(vm);
    const redeployVm = yield* Azure.Compute.RedeployVirtualMachine(vm);
    const runCommand = yield* Azure.Compute.RunVirtualMachineCommand(vm);
    const startVmss = yield* Azure.Compute.StartVirtualMachineScaleSet(scaleSet);
    const powerOffVmss = yield* Azure.Compute.PowerOffVirtualMachineScaleSet(scaleSet);
    const deallocateVmss = yield* Azure.Compute.DeallocateVirtualMachineScaleSet(scaleSet);
    const restartVmss = yield* Azure.Compute.RestartVirtualMachineScaleSet(scaleSet);
    const redeployVmss = yield* Azure.Compute.RedeployVirtualMachineScaleSet(scaleSet);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        switch (url.pathname) {
          case "/vm/start":
            return yield* respond(startVm());
          case "/vm/power-off":
            return yield* respond(powerOffVm({ skipShutdown: true }));
          case "/vm/deallocate":
            return yield* respond(deallocateVm());
          case "/vm/restart":
            return yield* respond(restartVm());
          case "/vm/redeploy":
            return yield* respond(redeployVm());
          case "/vm/run-command":
            return yield* respond(
              runCommand({
                commandId: "RunShellScript",
                script: [`echo ${RUN_COMMAND_TOKEN}`],
              }),
            );
          case "/vmss/start":
            return yield* respond(startVmss());
          case "/vmss/power-off":
            return yield* respond(powerOffVmss({ skipShutdown: true }));
          case "/vmss/deallocate":
            return yield* respond(deallocateVmss({ instanceIds: ["0"] }));
          case "/vmss/restart":
            return yield* respond(restartVmss());
          case "/vmss/redeploy":
            return yield* respond(redeployVmss({ instanceIds: ["0"] }));
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.Compute.StartVirtualMachineHttp,
        Azure.Compute.PowerOffVirtualMachineHttp,
        Azure.Compute.DeallocateVirtualMachineHttp,
        Azure.Compute.RestartVirtualMachineHttp,
        Azure.Compute.RedeployVirtualMachineHttp,
        Azure.Compute.RunVirtualMachineCommandHttp,
        Azure.Compute.StartVirtualMachineScaleSetHttp,
        Azure.Compute.PowerOffVirtualMachineScaleSetHttp,
        Azure.Compute.DeallocateVirtualMachineScaleSetHttp,
        Azure.Compute.RestartVirtualMachineScaleSetHttp,
        Azure.Compute.RedeployVirtualMachineScaleSetHttp,
      ),
    ),
  ),
) {}
