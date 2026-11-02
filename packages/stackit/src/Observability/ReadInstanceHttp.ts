import * as Layer from "effect/Layer";
import {
  INSTANCE_READ_ACCESS,
  makeInstanceClientHttpBinding,
  makeReadInstanceClient,
} from "./BindingHttp.ts";
import { ReadInstance } from "./ReadInstance.ts";

/**
 * HTTP implementation of {@link ReadInstance}.
 *
 * @layer
 * @provides Stackit.Observability.ReadInstance
 */
export const ReadInstanceHttp = Layer.effect(
  ReadInstance,
  makeInstanceClientHttpBinding({
    tag: "Stackit.Observability.ReadInstance",
    access: INSTANCE_READ_ACCESS,
    makeClient: makeReadInstanceClient,
  }),
);
