import * as git from "@distilled.cloud/stackit/git";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { CreateUser } from "./CreateUser.ts";

/**
 * HTTP implementation of {@link CreateUser}.
 *
 * @layer
 * @provides Stackit.Git.CreateUser
 */
export const CreateUserHttp = Layer.effect(
  CreateUser,
  makeInstanceHttpBinding({
    tag: "Stackit.Git.CreateUser",
    permission: "git.instance.users.create",
    operation: git.createUser,
  }),
);
