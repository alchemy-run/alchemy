import * as logme from "@distilled.cloud/stackit/logme";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetInstance } from "./GetInstance.ts";

/**
 * HTTP implementation of {@link GetInstance}.
 *
 * @layer
 * @provides Stackit.LogMe.GetInstance
 */
export const GetInstanceHttp = Layer.effect(
  GetInstance,
  makeInstanceHttpBinding({
    tag: "Stackit.LogMe.GetInstance",
    permission: "logme.instance.get",
    operation: logme.getInstance,
  }),
);
