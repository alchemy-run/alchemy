import * as Layer from "effect/Layer";
import {
  MONGODB_READ_ACCESS,
  makeInstanceClientHttpBinding,
  makeReadInstanceClient,
} from "./BindingHttp.ts";
import { ReadInstance } from "./ReadInstance.ts";

/**
 * HTTP implementation of {@link ReadInstance}.
 *
 * @layer
 * @provides Stackit.MongoDBFlex.ReadInstance
 */
export const ReadInstanceHttp = Layer.effect(
  ReadInstance,
  makeInstanceClientHttpBinding({
    tag: "Stackit.MongoDBFlex.ReadInstance",
    access: MONGODB_READ_ACCESS,
    makeClient: makeReadInstanceClient,
  }),
);
