import * as Layer from "effect/Layer";
import { makeListSecretsClient, makeVaultClientBinding } from "./BindingHttp.ts";
import { ListSecrets } from "./ListSecrets.ts";

/**
 * HTTP implementation of {@link ListSecrets}.
 *
 * @layer
 * @provides Stackit.SecretsManager.ListSecrets
 */
export const ListSecretsHttp = Layer.effect(
  ListSecrets,
  makeVaultClientBinding({
    tag: "Stackit.SecretsManager.ListSecrets",
    write: false,
    makeClient: makeListSecretsClient,
  }),
);
