import * as valkey from "@distilled.cloud/stackit/valkey";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetUpdates } from "./GetUpdates.ts";

/**
 * HTTP implementation of {@link GetUpdates}.
 *
 * @layer
 * @provides Stackit.Valkey.GetUpdates
 */
export const GetUpdatesHttp = Layer.effect(
  GetUpdates,
  makeInstanceHttpBinding({
    tag: "Stackit.Valkey.GetUpdates",
    permission: "key-value-store.proxy.read",
    operation: valkey.getUpdates,
  }),
);
