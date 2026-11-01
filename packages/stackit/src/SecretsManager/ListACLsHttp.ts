import * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListACLs } from "./ListACLs.ts";

/**
 * HTTP implementation of {@link ListACLs}.
 *
 * @layer
 * @provides Stackit.SecretsManager.ListACLs
 */
export const ListACLsHttp = Layer.effect(
  ListACLs,
  makeInstanceHttpBinding({
    tag: "Stackit.SecretsManager.ListACLs",
    operation: secretsManager.listACLs,
  }),
);
