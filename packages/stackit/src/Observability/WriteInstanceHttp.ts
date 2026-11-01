import * as Layer from "effect/Layer";
import {
  INSTANCE_WRITE_ACCESS,
  makeInstanceClientHttpBinding,
  makeWriteInstanceClient,
} from "./BindingHttp.ts";
import { WriteInstance } from "./WriteInstance.ts";

/**
 * HTTP implementation of {@link WriteInstance}.
 *
 * @layer
 * @provides Stackit.Observability.WriteInstance
 */
export const WriteInstanceHttp = Layer.effect(
  WriteInstance,
  makeInstanceClientHttpBinding({
    tag: "Stackit.Observability.WriteInstance",
    access: INSTANCE_WRITE_ACCESS,
    makeClient: makeWriteInstanceClient,
  }),
);
