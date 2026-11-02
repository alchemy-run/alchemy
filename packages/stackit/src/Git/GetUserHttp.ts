import * as git from "@distilled.cloud/stackit/git";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetUser } from "./GetUser.ts";

/**
 * HTTP implementation of {@link GetUser}.
 *
 * @layer
 * @provides Stackit.Git.GetUser
 */
export const GetUserHttp = Layer.effect(
  GetUser,
  makeInstanceHttpBinding({
    tag: "Stackit.Git.GetUser",
    permission: "git.instance.users.get",
    operation: git.getUser,
  }),
);
