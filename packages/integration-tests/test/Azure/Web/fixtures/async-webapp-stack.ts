import * as Azure from "@alchemy.run/azure";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/** Storage account whose container the async web app receives in `env`. */
export const AsyncWebAppAccount = Azure.Storage.StorageAccount("AsyncWebAppAccount");

/** A resource passed through `env`: the handler gets its attributes. */
export const AsyncWebAppContainer = Effect.gen(function* () {
  const account = yield* AsyncWebAppAccount;
  return yield* Azure.Storage.BlobContainer("AsyncWebAppContainer", {
    storageAccount: account.storageAccountName,
  });
});

/**
 * Async (non-Effect) web app: `async-webapp.ts` default-exports
 * `{ fetch(request, env) }`, typed with {@link AsyncWebAppEnv}.
 */
export const AsyncWebApp = Effect.gen(function* () {
  const container = yield* AsyncWebAppContainer;
  return yield* Azure.Web.WebApp("AsyncWebApp", {
    main: `${import.meta.dirname}/async-webapp.ts`,
    // The testing subscription has F1 (free) quota in westus3.
    location: "westus3",
    sku: "F1",
    siteConfig: { alwaysOn: false },
    env: {
      GREETING: Config.String("AZURE_WEBAPP_TEST_GREETING").pipe(Config.withDefault("hello")),
      SECRET: Redacted.make("s3cret"),
      CONTAINER: container,
    },
  });
});

export type AsyncWebAppEnv = Azure.InferEnv<typeof AsyncWebApp>;
