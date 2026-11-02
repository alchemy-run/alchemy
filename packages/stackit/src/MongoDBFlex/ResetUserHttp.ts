import * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ResetUser } from "./ResetUser.ts";

/**
 * HTTP implementation of {@link ResetUser}.
 *
 * @layer
 * @provides Stackit.MongoDBFlex.ResetUser
 */
export const ResetUserHttp = Layer.effect(
  ResetUser,
  makeInstanceHttpBinding({
    tag: "Stackit.MongoDBFlex.ResetUser",
    access: { permissions: ["mongodb-flex.user.reset"] },
    operation: mongodb.resetUser,
  }),
);
