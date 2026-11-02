import * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListUsers } from "./ListUsers.ts";

/**
 * HTTP implementation of {@link ListUsers}.
 *
 * @layer
 * @provides Stackit.SecretsManager.ListUsers
 */
export const ListUsersHttp = Layer.effect(
  ListUsers,
  makeInstanceHttpBinding({
    tag: "Stackit.SecretsManager.ListUsers",
    operation: secretsManager.listUsers,
  }),
);
