import * as git from "@distilled.cloud/stackit/git";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding } from "./BindingHttp.ts";
import { ListRunnerFamilies } from "./ListRunnerFamilies.ts";

/**
 * HTTP implementation of {@link ListRunnerFamilies}.
 *
 * @layer
 * @provides Stackit.Git.ListRunnerFamilies
 */
export const ListRunnerFamiliesHttp = Layer.effect(
  ListRunnerFamilies,
  makeProjectHttpBinding({
    tag: "Stackit.Git.ListRunnerFamilies",
    permission: "git.runner.get",
    operation: git.listRunnerFamilies,
  }),
);
