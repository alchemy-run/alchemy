import * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetUser } from "./GetUser.ts";

/**
 * HTTP implementation of {@link GetUser}.
 *
 * @layer
 * @provides Stackit.MongoDBFlex.GetUser
 */
export const GetUserHttp = Layer.effect(
  GetUser,
  makeInstanceHttpBinding({
    tag: "Stackit.MongoDBFlex.GetUser",
    access: { permissions: ["mongodb-flex.user.get"] },
    operation: mongodb.getUser,
  }),
);
