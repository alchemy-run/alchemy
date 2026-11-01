import * as Layer from "effect/Layer";
import {
  INSTANCE_READ_WRITE_ACCESS,
  makeInstanceClientHttpBinding,
  makeReadWriteInstanceClient,
} from "./BindingHttp.ts";
import { ReadWriteInstance } from "./ReadWriteInstance.ts";

/**
 * HTTP implementation of {@link ReadWriteInstance}.
 *
 * @layer
 * @provides Stackit.Observability.ReadWriteInstance
 */
export const ReadWriteInstanceHttp = Layer.effect(
  ReadWriteInstance,
  makeInstanceClientHttpBinding({
    tag: "Stackit.Observability.ReadWriteInstance",
    access: INSTANCE_READ_WRITE_ACCESS,
    makeClient: makeReadWriteInstanceClient,
  }),
);
