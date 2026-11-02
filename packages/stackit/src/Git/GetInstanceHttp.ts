import * as git from "@distilled.cloud/stackit/git";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetInstance } from "./GetInstance.ts";

/**
 * HTTP implementation of {@link GetInstance}.
 *
 * @layer
 * @provides Stackit.Git.GetInstance
 */
export const GetInstanceHttp = Layer.effect(
  GetInstance,
  makeInstanceHttpBinding({
    tag: "Stackit.Git.GetInstance",
    permission: "git.instance.get",
    operation: git.getInstance,
  }),
);
