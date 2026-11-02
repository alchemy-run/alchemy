import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetInstance } from "./GetInstance.ts";

/**
 * HTTP implementation of {@link GetInstance}.
 *
 * @layer
 * @provides Stackit.Observability.GetInstance
 */
export const GetInstanceHttp = Layer.effect(
  GetInstance,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.GetInstance",
    access: INSTANCE_READ_ACCESS,
    operation: observability.getInstance,
  }),
);
