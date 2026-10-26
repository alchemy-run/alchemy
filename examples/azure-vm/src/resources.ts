import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";

/** Region of every resource in the example. */
export const LOCATION = "eastus";

/**
 * 1 vCPU, 2 GiB F-series v7 (about $0.04 per hour). Pick any Linux size
 * your subscription has quota for.
 */
export const VM_SIZE = "Standard_F1als_v7";

/** Port the program listens on (the VM's default). */
export const PORT = 3000;

/**
 * An SSH key pair Azure generates for the VM's admin user. The private key
 * is kept as the secret `privateKey` attribute in the stack's state.
 */
export const AdminKey = Azure.Compute.SshPublicKey("AdminKey", {
  location: LOCATION,
  generateKeyPair: true,
});

export const Data = Azure.Storage.StorageAccount("Data", { location: LOCATION });

/** Jobs the API enqueues and the VM's background worker processes. */
export const Jobs = Effect.gen(function* () {
  const account = yield* Data;
  return yield* Azure.Storage.Queue("Jobs", { storageAccount: account.storageAccountName });
});

/** Where the worker writes each job's result, one blob per job. */
export const Results = Effect.gen(function* () {
  const account = yield* Data;
  return yield* Azure.Storage.BlobContainer("Results", {
    storageAccount: account.storageAccountName,
  });
});
