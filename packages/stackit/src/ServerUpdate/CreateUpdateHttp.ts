import * as serverUpdate from "@distilled.cloud/stackit/server_update";
import * as Layer from "effect/Layer";
import { makeServerHttpBinding } from "./BindingHttp.ts";
import { CreateUpdate } from "./CreateUpdate.ts";

/**
 * HTTP implementation of {@link CreateUpdate}.
 *
 * @layer
 * @provides Stackit.ServerUpdate.CreateUpdate
 */
export const CreateUpdateHttp = Layer.effect(
  CreateUpdate,
  makeServerHttpBinding({
    tag: "Stackit.ServerUpdate.CreateUpdate",
    access: { permissions: ["server-update.update.create"] },
    operation: serverUpdate.createUpdate,
  }),
);
