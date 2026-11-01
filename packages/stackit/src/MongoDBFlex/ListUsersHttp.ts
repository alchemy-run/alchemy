import * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListUsers } from "./ListUsers.ts";

/**
 * HTTP implementation of {@link ListUsers}.
 *
 * @layer
 * @provides Stackit.MongoDBFlex.ListUsers
 */
export const ListUsersHttp = Layer.effect(
  ListUsers,
  makeInstanceHttpBinding({
    tag: "Stackit.MongoDBFlex.ListUsers",
    access: { permissions: ["mongodb-flex.user.list"] },
    operation: mongodb.listUsers,
  }),
);
