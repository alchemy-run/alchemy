import * as postgres from "@distilled.cloud/stackit/postgres_flex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListUsers } from "./ListUsers.ts";

/**
 * HTTP implementation of {@link ListUsers}.
 *
 * @layer
 * @provides Stackit.PostgresFlex.ListUsers
 */
export const ListUsersHttp = Layer.effect(
  ListUsers,
  makeInstanceHttpBinding({
    tag: "Stackit.PostgresFlex.ListUsers",
    access: { permissions: ["postgres-flex.user.list"] },
    operation: postgres.listUsers,
  }),
);
