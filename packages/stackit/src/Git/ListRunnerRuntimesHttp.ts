import * as git from "@distilled.cloud/stackit/git";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding } from "./BindingHttp.ts";
import { ListRunnerRuntimes } from "./ListRunnerRuntimes.ts";

/**
 * HTTP implementation of {@link ListRunnerRuntimes}.
 *
 * @layer
 * @provides Stackit.Git.ListRunnerRuntimes
 */
export const ListRunnerRuntimesHttp = Layer.effect(
  ListRunnerRuntimes,
  makeProjectHttpBinding({
    tag: "Stackit.Git.ListRunnerRuntimes",
    permission: "git.runner.get",
    operation: git.listRunnerRuntimes,
  }),
);
