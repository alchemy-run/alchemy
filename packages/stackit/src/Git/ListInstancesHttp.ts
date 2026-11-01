import * as git from "@distilled.cloud/stackit/git";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding } from "./BindingHttp.ts";
import { ListInstances } from "./ListInstances.ts";

/**
 * HTTP implementation of {@link ListInstances}.
 *
 * @layer
 * @provides Stackit.Git.ListInstances
 */
export const ListInstancesHttp = Layer.effect(
  ListInstances,
  makeProjectHttpBinding({
    tag: "Stackit.Git.ListInstances",
    permission: "git.instance.list",
    operation: git.listInstances,
  }),
);
