import * as git from "@distilled.cloud/stackit/git";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListUsers } from "./ListUsers.ts";

/**
 * HTTP implementation of {@link ListUsers}.
 *
 * @layer
 * @provides Stackit.Git.ListUsers
 */
export const ListUsersHttp = Layer.effect(
  ListUsers,
  makeInstanceHttpBinding({
    tag: "Stackit.Git.ListUsers",
    permission: "git.instance.users.get",
    operation: git.getUsers,
  }),
);
