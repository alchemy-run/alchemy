import * as serverUpdate from "@distilled.cloud/stackit/server_update";
import * as Layer from "effect/Layer";
import { makeServerHttpBinding } from "./BindingHttp.ts";
import { ListUpdates } from "./ListUpdates.ts";

/**
 * HTTP implementation of {@link ListUpdates}.
 *
 * @layer
 * @provides Stackit.ServerUpdate.ListUpdates
 */
export const ListUpdatesHttp = Layer.effect(
  ListUpdates,
  makeServerHttpBinding({
    tag: "Stackit.ServerUpdate.ListUpdates",
    access: { permissions: ["server-update.update.list"] },
    operation: serverUpdate.listUpdates,
  }),
);
