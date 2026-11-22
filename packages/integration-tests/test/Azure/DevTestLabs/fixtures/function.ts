import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { PUBLIC_KEY_1 } from "../../Compute/helpers.ts";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";
import { LAB_VM_SIZE, labNetworkFixture } from "../util.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

/** One Linux lab VM in a lab subnet without a public IP. */
export const LabVm = Effect.gen(function* () {
  const { group, lab, subnet, network } = yield* labNetworkFixture();
  return yield* Azure.DevTestLabs.VirtualMachine("DtlBindingsVm", {
    resourceGroup: group.resourceGroupName,
    lab: lab.labName,
    size: LAB_VM_SIZE,
    galleryImageReference: {
      publisher: "Canonical",
      offer: "0001-com-ubuntu-server-jammy",
      sku: "22_04-lts-gen2",
      osType: "Linux",
    },
    userName: "azureuser",
    isAuthenticationWithSshKey: true,
    sshKey: PUBLIC_KEY_1,
    labVirtualNetworkId: network.labVirtualNetworkId,
    labSubnetName: subnet.subnetName,
    disallowPublicIpAddress: true,
    storageType: "Standard",
  });
});

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result: result ?? null })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Effect-native Azure Function exercising every DevTest Labs
 * runtime-action binding on a managed-identity host, one route per binding.
 * Routes answer `{ ok, result | error }` with a 500 on error, so a caller
 * retries through the cold start and role propagation, and a real failure
 * shows the ARM error.
 */
export default class DevTestLabsFunction extends Azure.Functions.Function<DevTestLabsFunction>()(
  "DevTestLabsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const vm = yield* LabVm;

    const startVm = yield* Azure.DevTestLabs.StartVirtualMachine(vm);
    const stopVm = yield* Azure.DevTestLabs.StopVirtualMachine(vm);
    const restartVm = yield* Azure.DevTestLabs.RestartVirtualMachine(vm);
    const redeployVm = yield* Azure.DevTestLabs.RedeployVirtualMachine(vm);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        switch (url.pathname) {
          case "/start":
            return yield* respond(Effect.as(startVm(), "started"));
          case "/stop":
            return yield* respond(Effect.as(stopVm(), "stopped"));
          case "/restart":
            return yield* respond(Effect.as(restartVm(), "restarted"));
          case "/redeploy":
            return yield* respond(Effect.as(redeployVm(), "redeployed"));
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.DevTestLabs.StartVirtualMachineHttp,
        Azure.DevTestLabs.StopVirtualMachineHttp,
        Azure.DevTestLabs.RestartVirtualMachineHttp,
        Azure.DevTestLabs.RedeployVirtualMachineHttp,
      ),
    ),
  ),
) {}
