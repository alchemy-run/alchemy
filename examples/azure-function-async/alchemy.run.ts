import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/** The storage account that holds the notes. */
export const Account = Azure.Storage.StorageAccount("Account", {
  sku: "Standard_LRS",
});

/** The private blob container the API writes notes to. */
export const Notes = Effect.gen(function* () {
  const account = yield* Account;
  return yield* Azure.Storage.BlobContainer("Notes", {
    storageAccount: account.storageAccountName,
  });
});

/**
 * A plain `fetch` handler (`src/api.ts`, no Effect) on Flex Consumption.
 * Each `env` entry becomes an app setting; `NOTES` arrives as the
 * container's attributes.
 */
export const Api = Effect.gen(function* () {
  const notes = yield* Notes;
  return yield* Azure.Functions.Function("Api", {
    main: "./src/api.ts",
    env: {
      GREETING: Config.String("GREETING").pipe(Config.withDefault("hello")),
      NOTES: notes,
    },
  });
});

/** The handler's `env` argument: `{ GREETING: string; NOTES: { containerName, … } }`. */
export type ApiEnv = Azure.InferEnv<typeof Api>;

export default Alchemy.Stack(
  "AzureFunctionAsyncExample",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const notes = yield* Notes;
    const api = yield* Api;

    // An async Function has no bindings, so grant its managed identity
    // read/write on the container explicitly.
    const access = yield* Azure.Authorization.RoleAssignment("ApiWritesNotes", {
      scope: notes.containerId,
      roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataContributor,
      principalId: api.principalId.as<string>(),
      principalType: "ServicePrincipal",
    });

    return {
      url: api.url,
      functionApp: api.functionAppName,
      resourceGroup: api.resourceGroup,
      storageAccount: notes.storageAccount,
      container: notes.containerName,
      roleScope: access.scope,
      roleAssignment: access.roleAssignmentName,
    };
  }),
);
