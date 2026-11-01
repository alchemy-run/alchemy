import * as dremio from "@distilled.cloud/stackit/dremio";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListUsers } from "./ListUsers.ts";

/**
 * HTTP implementation of {@link ListUsers}.
 *
 * @layer
 * @provides Stackit.Dremio.ListUsers
 */
export const ListUsersHttp = Layer.effect(
  ListUsers,
  makeInstanceHttpBinding({
    tag: "Stackit.Dremio.ListUsers",
    permission: "dremio.user.list",
    operation: dremio.listDremioUsers,
  }),
);
