import * as git from "@distilled.cloud/stackit/git";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { UpdateUser } from "./UpdateUser.ts";

/**
 * HTTP implementation of {@link UpdateUser}.
 *
 * @layer
 * @provides Stackit.Git.UpdateUser
 */
export const UpdateUserHttp = Layer.effect(
  UpdateUser,
  makeInstanceHttpBinding({
    tag: "Stackit.Git.UpdateUser",
    permission: "git.instance.update",
    operation: git.updateUser,
  }),
);
