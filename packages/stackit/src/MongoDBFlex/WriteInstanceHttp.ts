import * as Layer from "effect/Layer";
import {
  MONGODB_WRITE_ACCESS,
  makeInstanceClientHttpBinding,
  makeWriteInstanceClient,
} from "./BindingHttp.ts";
import { WriteInstance } from "./WriteInstance.ts";

/**
 * HTTP implementation of {@link WriteInstance}.
 *
 * @layer
 * @provides Stackit.MongoDBFlex.WriteInstance
 */
export const WriteInstanceHttp = Layer.effect(
  WriteInstance,
  makeInstanceClientHttpBinding({
    tag: "Stackit.MongoDBFlex.WriteInstance",
    access: MONGODB_WRITE_ACCESS,
    makeClient: makeWriteInstanceClient,
  }),
);
