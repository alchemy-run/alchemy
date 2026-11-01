import * as Layer from "effect/Layer";
import {
  SQLSERVER_READ_WRITE_ACCESS,
  makeInstanceClientHttpBinding,
  makeReadWriteInstanceClient,
} from "./BindingHttp.ts";
import { ReadWriteInstance } from "./ReadWriteInstance.ts";

/**
 * HTTP implementation of {@link ReadWriteInstance}.
 *
 * @layer
 * @provides Stackit.SQLServerFlex.ReadWriteInstance
 */
export const ReadWriteInstanceHttp = Layer.effect(
  ReadWriteInstance,
  makeInstanceClientHttpBinding({
    tag: "Stackit.SQLServerFlex.ReadWriteInstance",
    access: SQLSERVER_READ_WRITE_ACCESS,
    makeClient: makeReadWriteInstanceClient,
  }),
);
