import * as Layer from "effect/Layer";
import {
  MONGODB_READ_WRITE_ACCESS,
  makeInstanceClientHttpBinding,
  makeReadWriteInstanceClient,
} from "./BindingHttp.ts";
import { ReadWriteInstance } from "./ReadWriteInstance.ts";

/**
 * HTTP implementation of {@link ReadWriteInstance}.
 *
 * @layer
 * @provides Stackit.MongoDBFlex.ReadWriteInstance
 */
export const ReadWriteInstanceHttp = Layer.effect(
  ReadWriteInstance,
  makeInstanceClientHttpBinding({
    tag: "Stackit.MongoDBFlex.ReadWriteInstance",
    access: MONGODB_READ_WRITE_ACCESS,
    makeClient: makeReadWriteInstanceClient,
  }),
);
