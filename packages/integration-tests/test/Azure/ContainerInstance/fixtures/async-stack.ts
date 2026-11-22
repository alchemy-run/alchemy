import * as Azure from "@alchemy.run/azure";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/** Storage account whose container the async program receives in `env`. */
export const AsyncAciAccount = Azure.Storage.StorageAccount("AsyncAciAccount");

/** A resource passed through `env`: the handler gets its attributes. */
export const AsyncAciContainer = Effect.gen(function* () {
  const account = yield* AsyncAciAccount;
  return yield* Azure.Storage.BlobContainer("AsyncAciContainer", {
    storageAccount: account.storageAccountName,
  });
});

/**
 * Async (non-Effect) program on a container group: `async-container.ts`
 * default-exports `{ fetch(request, env) }`, typed with {@link AsyncContainerEnv}.
 */
export const AsyncContainer = Effect.gen(function* () {
  const container = yield* AsyncAciContainer;
  return yield* Azure.ContainerInstance.ContainerGroup("AsyncContainer", {
    main: `${import.meta.dirname}/async-container.ts`,
    cpu: 0.5,
    memoryInGB: 1,
    env: {
      GREETING: Config.String("AZURE_ACI_TEST_GREETING").pipe(Config.withDefault("hello")),
      SECRET: Redacted.make("s3cret"),
      CONTAINER: container,
    },
  });
});

export type AsyncContainerEnv = Azure.InferEnv<typeof AsyncContainer>;
