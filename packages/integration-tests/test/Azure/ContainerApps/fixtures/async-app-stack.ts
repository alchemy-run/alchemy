import * as Azure from "@alchemy.run/azure";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { APP_LOCATION, AppData, AppEnvironment } from "./app-resources.ts";

/** A resource passed through `env`: the handler gets its attributes. */
export const AsyncAppContainer = Effect.gen(function* () {
  const account = yield* AppData;
  return yield* Azure.Storage.BlobContainer("AsyncAppContainer", {
    storageAccount: account.storageAccountName,
  });
});

/**
 * Async (non-Effect) Container App: `async-app.ts` default-exports
 * `{ fetch(request, env) }`, typed with {@link AsyncAppEnv}.
 */
export const AsyncApp = Effect.gen(function* () {
  const environment = yield* AppEnvironment;
  const container = yield* AsyncAppContainer;
  return yield* Azure.ContainerApps.ContainerApp("AsyncApp", {
    main: `${import.meta.dirname}/async-app.ts`,
    location: APP_LOCATION,
    environmentId: environment.environmentId,
    cpu: 0.25,
    memory: "0.5Gi",
    env: {
      GREETING: Config.String("AZURE_CA_ASYNC_GREETING").pipe(Config.withDefault("hello")),
      SECRET: Redacted.make("s3cret"),
      CONTAINER: container,
    },
  });
});

export type AsyncAppEnv = Azure.InferEnv<typeof AsyncApp>;
