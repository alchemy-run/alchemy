import * as git from "@distilled.cloud/stackit/git";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { DeleteUser } from "./DeleteUser.ts";

/**
 * HTTP implementation of {@link DeleteUser}.
 *
 * @layer
 * @provides Stackit.Git.DeleteUser
 */
export const DeleteUserHttp = Layer.effect(
  DeleteUser,
  makeInstanceHttpBinding({
    tag: "Stackit.Git.DeleteUser",
    permission: "git.instance.users.delete",
    operation: git.deleteUser,
  }),
);
