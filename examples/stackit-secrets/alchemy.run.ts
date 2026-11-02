import * as Stackit from "@alchemy.run/stackit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";
import { ApiKey, ApiKeyValue, DataKey, Vault } from "./src/resources.ts";

export default Alchemy.Stack(
  "StackitSecretsExample",
  {
    providers: Layer.mergeAll(Stackit.providers(), Alchemy.RandomProvider()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const vault = yield* Vault;
    const apiKey = yield* ApiKey;
    const apiKeyValue = yield* ApiKeyValue;
    const dataKey = yield* DataKey;
    const api = yield* Api;

    return {
      url: api.url,
      projectId: vault.projectId,
      instanceId: vault.instanceId,
      secretPath: apiKey.path,
      // `Redacted`, so it stays out of logs. The test presents it.
      apiKey: apiKeyValue.text,
      region: dataKey.region,
      keyRingId: dataKey.keyRingId,
      keyId: dataKey.keyId,
    };
  }),
);
