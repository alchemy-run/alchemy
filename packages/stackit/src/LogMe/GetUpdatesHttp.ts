import * as logme from "@distilled.cloud/stackit/logme";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetUpdates } from "./GetUpdates.ts";

/**
 * HTTP implementation of {@link GetUpdates}.
 *
 * @layer
 * @provides Stackit.LogMe.GetUpdates
 */
export const GetUpdatesHttp = Layer.effect(
  GetUpdates,
  makeInstanceHttpBinding({
    tag: "Stackit.LogMe.GetUpdates",
    permission: "logme.proxy.read",
    operation: logme.getUpdates,
  }),
);
