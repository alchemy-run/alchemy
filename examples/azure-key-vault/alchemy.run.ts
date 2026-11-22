import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";
import { ApiKey, DataKey, InitialApiKey, SigningKey, Vault } from "./src/resources.ts";

/** Azure, plus `Alchemy.Random` for the first API key. */
export const providers = () => Layer.mergeAll(Azure.providers(), Alchemy.RandomProvider());

export default Alchemy.Stack(
  "AzureKeyVaultExample",
  { providers: providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const vault = yield* Vault;
    const initialApiKey = yield* InitialApiKey;
    const apiKey = yield* ApiKey;
    const dataKey = yield* DataKey;
    const signingKey = yield* SigningKey;
    const api = yield* Api;

    return {
      url: api.url,
      /** The first `ApiKey` version. `POST /rotate` replaces it. */
      apiKey: initialApiKey.text,
      resourceGroup: vault.resourceGroup,
      vaultName: vault.vaultName,
      location: vault.location,
      secretName: apiKey.secretName,
      dataKeyName: dataKey.keyName,
      signingKeyName: signingKey.keyName,
      functionAppName: api.functionAppName,
    };
  }),
);
