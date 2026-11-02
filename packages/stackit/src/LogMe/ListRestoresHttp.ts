import * as logme from "@distilled.cloud/stackit/logme";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListRestores } from "./ListRestores.ts";

/**
 * HTTP implementation of {@link ListRestores}.
 *
 * @layer
 * @provides Stackit.LogMe.ListRestores
 */
export const ListRestoresHttp = Layer.effect(
  ListRestores,
  makeInstanceHttpBinding({
    tag: "Stackit.LogMe.ListRestores",
    permission: "logme.proxy.read",
    operation: logme.listRestores,
  }),
);
