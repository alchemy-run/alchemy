import * as git from "@distilled.cloud/stackit/git";
import * as Layer from "effect/Layer";
import { makeRunnerHttpBinding } from "./BindingHttp.ts";
import { GetRunner } from "./GetRunner.ts";

/**
 * HTTP implementation of {@link GetRunner}.
 *
 * @layer
 * @provides Stackit.Git.GetRunner
 */
export const GetRunnerHttp = Layer.effect(
  GetRunner,
  makeRunnerHttpBinding({
    tag: "Stackit.Git.GetRunner",
    permission: "git.runner.get",
    operation: git.getRunner,
  }),
);
