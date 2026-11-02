import * as Layer from "effect/Layer";
import {
  SQLSERVER_READ_ACCESS,
  makeInstanceClientHttpBinding,
  makeReadInstanceClient,
} from "./BindingHttp.ts";
import { ReadInstance } from "./ReadInstance.ts";

/**
 * HTTP implementation of {@link ReadInstance}.
 *
 * @layer
 * @provides Stackit.SQLServerFlex.ReadInstance
 */
export const ReadInstanceHttp = Layer.effect(
  ReadInstance,
  makeInstanceClientHttpBinding({
    tag: "Stackit.SQLServerFlex.ReadInstance",
    access: SQLSERVER_READ_ACCESS,
    makeClient: makeReadInstanceClient,
  }),
);
