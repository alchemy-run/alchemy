import * as Layer from "effect/Layer";
import {
  POSTGRES_READ_WRITE_ACCESS,
  makeInstanceClientHttpBinding,
  makeReadWriteInstanceClient,
} from "./BindingHttp.ts";
import { ReadWriteInstance } from "./ReadWriteInstance.ts";

/**
 * HTTP implementation of {@link ReadWriteInstance}.
 *
 * @layer
 * @provides Stackit.PostgresFlex.ReadWriteInstance
 */
export const ReadWriteInstanceHttp = Layer.effect(
  ReadWriteInstance,
  makeInstanceClientHttpBinding({
    tag: "Stackit.PostgresFlex.ReadWriteInstance",
    access: POSTGRES_READ_WRITE_ACCESS,
    makeClient: makeReadWriteInstanceClient,
  }),
);
