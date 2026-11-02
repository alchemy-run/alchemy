import * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { RestoreInstance } from "./RestoreInstance.ts";

/**
 * HTTP implementation of {@link RestoreInstance}.
 *
 * @layer
 * @provides Stackit.MongoDBFlex.RestoreInstance
 */
export const RestoreInstanceHttp = Layer.effect(
  RestoreInstance,
  makeInstanceHttpBinding({
    tag: "Stackit.MongoDBFlex.RestoreInstance",
    access: { permissions: ["mongodb-flex.backup.restore-snapshot"] },
    operation: mongodb.restoreInstance,
  }),
);
