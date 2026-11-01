import * as Layer from "effect/Layer";
import {
  POSTGRES_WRITE_ACCESS,
  makeInstanceClientHttpBinding,
  makeWriteInstanceClient,
} from "./BindingHttp.ts";
import { WriteInstance } from "./WriteInstance.ts";

/**
 * HTTP implementation of {@link WriteInstance}.
 *
 * @layer
 * @provides Stackit.PostgresFlex.WriteInstance
 */
export const WriteInstanceHttp = Layer.effect(
  WriteInstance,
  makeInstanceClientHttpBinding({
    tag: "Stackit.PostgresFlex.WriteInstance",
    access: POSTGRES_WRITE_ACCESS,
    makeClient: makeWriteInstanceClient,
  }),
);
