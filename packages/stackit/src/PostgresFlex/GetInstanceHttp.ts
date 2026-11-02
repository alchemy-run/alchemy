import * as postgres from "@distilled.cloud/stackit/postgres_flex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetInstance } from "./GetInstance.ts";

/**
 * HTTP implementation of {@link GetInstance}.
 *
 * @layer
 * @provides Stackit.PostgresFlex.GetInstance
 */
export const GetInstanceHttp = Layer.effect(
  GetInstance,
  makeInstanceHttpBinding({
    tag: "Stackit.PostgresFlex.GetInstance",
    access: { permissions: ["postgres-flex.instance.get"] },
    operation: postgres.getInstance,
  }),
);
