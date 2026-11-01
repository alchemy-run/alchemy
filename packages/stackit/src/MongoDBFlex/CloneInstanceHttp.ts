import * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { CloneInstance } from "./CloneInstance.ts";

/**
 * HTTP implementation of {@link CloneInstance}.
 *
 * @layer
 * @provides Stackit.MongoDBFlex.CloneInstance
 */
export const CloneInstanceHttp = Layer.effect(
  CloneInstance,
  makeInstanceHttpBinding({
    tag: "Stackit.MongoDBFlex.CloneInstance",
    access: { permissions: ["mongodb-flex.backup.clone"] },
    operation: mongodb.cloneInstance,
  }),
);
