import * as serverUpdate from "@distilled.cloud/stackit/server_update";
import * as Layer from "effect/Layer";
import { makeServerHttpBinding } from "./BindingHttp.ts";
import { GetUpdate } from "./GetUpdate.ts";

/**
 * HTTP implementation of {@link GetUpdate}.
 *
 * @layer
 * @provides Stackit.ServerUpdate.GetUpdate
 */
export const GetUpdateHttp = Layer.effect(
  GetUpdate,
  makeServerHttpBinding({
    tag: "Stackit.ServerUpdate.GetUpdate",
    access: { permissions: ["server-update.update.get"] },
    operation: serverUpdate.getUpdate,
  }),
);
