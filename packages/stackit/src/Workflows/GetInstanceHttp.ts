import * as workflows from "@distilled.cloud/stackit/workflows";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetInstance } from "./GetInstance.ts";

/**
 * HTTP implementation of {@link GetInstance}.
 *
 * @layer
 * @provides Stackit.Workflows.GetInstance
 */
export const GetInstanceHttp = Layer.effect(
  GetInstance,
  makeInstanceHttpBinding({
    tag: "Stackit.Workflows.GetInstance",
    permission: "workflows.instance.get",
    operation: workflows.getInstance,
  }),
);
