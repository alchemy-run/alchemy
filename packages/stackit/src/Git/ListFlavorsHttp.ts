import * as git from "@distilled.cloud/stackit/git";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding } from "./BindingHttp.ts";
import { ListFlavors } from "./ListFlavors.ts";

/**
 * HTTP implementation of {@link ListFlavors}.
 *
 * @layer
 * @provides Stackit.Git.ListFlavors
 */
export const ListFlavorsHttp = Layer.effect(
  ListFlavors,
  makeProjectHttpBinding({
    tag: "Stackit.Git.ListFlavors",
    permission: "git.instance.create",
    operation: git.listFlavors,
  }),
);
