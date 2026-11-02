import * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListUsers } from "./ListUsers.ts";

/**
 * HTTP implementation of {@link ListUsers}.
 *
 * @layer
 * @provides Stackit.SQLServerFlex.ListUsers
 */
export const ListUsersHttp = Layer.effect(
  ListUsers,
  makeInstanceHttpBinding({
    tag: "Stackit.SQLServerFlex.ListUsers",
    access: { permissions: ["sqlserver-flex.user.list"] },
    operation: sqlserver.listUsers,
  }),
);
