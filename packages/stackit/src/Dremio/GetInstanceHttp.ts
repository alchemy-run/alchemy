import * as dremio from "@distilled.cloud/stackit/dremio";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetInstance } from "./GetInstance.ts";

/**
 * HTTP implementation of {@link GetInstance}.
 *
 * @layer
 * @provides Stackit.Dremio.GetInstance
 */
export const GetInstanceHttp = Layer.effect(
  GetInstance,
  makeInstanceHttpBinding({
    tag: "Stackit.Dremio.GetInstance",
    permission: "dremio.instance.get",
    operation: dremio.getDremioInstance,
  }),
);
