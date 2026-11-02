import * as Layer from "effect/Layer";
import {
  SQLSERVER_WRITE_ACCESS,
  makeInstanceClientHttpBinding,
  makeWriteInstanceClient,
} from "./BindingHttp.ts";
import { WriteInstance } from "./WriteInstance.ts";

/**
 * HTTP implementation of {@link WriteInstance}.
 *
 * @layer
 * @provides Stackit.SQLServerFlex.WriteInstance
 */
export const WriteInstanceHttp = Layer.effect(
  WriteInstance,
  makeInstanceClientHttpBinding({
    tag: "Stackit.SQLServerFlex.WriteInstance",
    access: SQLSERVER_WRITE_ACCESS,
    makeClient: makeWriteInstanceClient,
  }),
);
