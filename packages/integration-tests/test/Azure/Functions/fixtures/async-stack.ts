import * as Azure from "@alchemy.run/azure";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/** Storage account whose container the async Function receives in `env`. */
export const AsyncAccount = Azure.Storage.StorageAccount("AsyncFnAccount");

/** A resource passed through `env`: the handler gets its attributes. */
export const AsyncContainer = Effect.gen(function* () {
  const account = yield* AsyncAccount;
  return yield* Azure.Storage.BlobContainer("AsyncFnContainer", {
    storageAccount: account.storageAccountName,
  });
});

/**
 * Async (non-Effect) Function: `async-function.ts` default-exports
 * `{ fetch(request, env) }`, typed with {@link AsyncFunctionEnv}.
 */
export const AsyncFunction = Effect.gen(function* () {
  const container = yield* AsyncContainer;
  return yield* Azure.Functions.Function("AsyncFunction", {
    main: `${import.meta.dirname}/async-function.ts`,
    env: {
      GREETING: Config.String("AZURE_FN_TEST_GREETING").pipe(Config.withDefault("hello")),
      SECRET: Redacted.make("s3cret"),
      CONTAINER: container,
    },
  });
});

export type AsyncFunctionEnv = Azure.InferEnv<typeof AsyncFunction>;
