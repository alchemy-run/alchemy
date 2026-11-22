import * as Azure from "@alchemy.run/azure";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

// eastus has zero App Service quota; westus2 accepts S1 plans.
const LOCATION = "westus2";

/** A dedicated (S1, Linux) plan: covers the non-Flex deploy path. */
export const AsyncAppPlan = Azure.Web.AppServicePlan("AsyncFnAppPlan", {
  location: LOCATION,
  sku: "S1",
});

/** Host storage, and the account whose container the handler gets in `env`. */
export const AsyncAppStorage = Azure.Storage.StorageAccount("AsyncFnAppStorage", {
  location: LOCATION,
});

/** A resource passed through `env`: the handler gets its attributes. */
export const AsyncAppContainer = Effect.gen(function* () {
  const account = yield* AsyncAppStorage;
  return yield* Azure.Storage.BlobContainer("AsyncFnAppContainer", {
    storageAccount: account.storageAccountName,
  });
});

/**
 * Async (non-Effect) function app: `async-function-app.ts` default-exports
 * `{ fetch(request, env) }`, typed with {@link AsyncFunctionAppEnv}.
 */
export const AsyncFunctionApp = Effect.gen(function* () {
  const plan = yield* AsyncAppPlan;
  const account = yield* AsyncAppStorage;
  const container = yield* AsyncAppContainer;
  return yield* Azure.Web.FunctionApp("AsyncFunctionApp", {
    main: `${import.meta.dirname}/async-function-app.ts`,
    serverFarmId: plan.appServicePlanId,
    hostStorageAccountId: account.storageAccountId,
    env: {
      GREETING: Config.String("AZURE_FNAPP_ASYNC_GREETING").pipe(Config.withDefault("hello")),
      SECRET: Redacted.make("s3cret"),
      CONTAINER: container,
    },
  });
});

export type AsyncFunctionAppEnv = Azure.InferEnv<typeof AsyncFunctionApp>;
