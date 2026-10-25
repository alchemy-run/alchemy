import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { PUBLIC_KEY_1 } from "../helpers.ts";
import { PROGRAM_LOCATION, PROGRAM_VM_SIZE, programNetwork } from "./program-network.ts";

/** Storage account whose container the async VM receives in `env`. */
export const AsyncVmAccount = Azure.Storage.StorageAccount("AsyncVmAccount", {
  location: PROGRAM_LOCATION,
});

/** A resource passed through `env`: the handler gets its attributes. */
export const AsyncVmContainer = Effect.gen(function* () {
  const account = yield* AsyncVmAccount;
  return yield* Azure.Storage.BlobContainer("AsyncVmContainer", {
    storageAccount: account.storageAccountName,
  });
});

/**
 * Async (non-Effect) VM program: `async-vm.ts` default-exports
 * `{ fetch(request, env) }`, typed with {@link AsyncVmEnv}.
 */
export const AsyncVm = Effect.gen(function* () {
  const { nic } = yield* programNetwork("Async");
  const container = yield* AsyncVmContainer;
  return yield* Azure.Compute.VirtualMachine("AsyncVm", {
    main: `${import.meta.dirname}/async-vm.ts`,
    location: PROGRAM_LOCATION,
    vmSize: PROGRAM_VM_SIZE,
    networkInterfaceIds: [nic.networkInterfaceId],
    adminUsername: "azureuser",
    sshPublicKeys: [PUBLIC_KEY_1],
    env: {
      GREETING: "hello",
      SECRET: Redacted.make("s3cret"),
      CONTAINER: container,
    },
  });
});

export type AsyncVmEnv = Azure.InferEnv<typeof AsyncVm>;
