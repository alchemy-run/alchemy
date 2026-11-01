import * as valkey from "@distilled.cloud/stackit/valkey";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListRestores } from "./ListRestores.ts";

/**
 * HTTP implementation of {@link ListRestores}.
 *
 * @layer
 * @provides Stackit.Valkey.ListRestores
 */
export const ListRestoresHttp = Layer.effect(
  ListRestores,
  makeInstanceHttpBinding({
    tag: "Stackit.Valkey.ListRestores",
    permission: "key-value-store.proxy.read",
    operation: valkey.listRestores,
  }),
);
