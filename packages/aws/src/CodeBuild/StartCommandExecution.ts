import type * as SVC from "@distilled.cloud/aws/codebuild";
import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCodeBuildProjectHttpBinding } from "./BindingHttp.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:StartCommandExecution` — runs a shell
 * command in a running sandbox of the bound project. Poll the result with
 * {@link BatchGetCommandExecutions}.
 * ### Sandboxes
 * **Example:** Run a Command in a Sandbox
 * ```typescript
 * const startCommandExecution = yield* AWS.CodeBuild.StartCommandExecution(project);
 *
 * const { commandExecution } = yield* startCommandExecution({
 *   sandboxId,
 *   command: "echo hello",
 * });
 * ```
 *
 * @binding
 */
export interface StartCommandExecution extends Binding.Service<
  StartCommandExecution,
  "AWS.CodeBuild.StartCommandExecution",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request: SVC.StartCommandExecutionInput,
    ) => Effect.Effect<SVC.StartCommandExecutionOutput, SVC.StartCommandExecutionError>
  >
> {}
export const StartCommandExecution = Binding.Service<StartCommandExecution>(
  "AWS.CodeBuild.StartCommandExecution",
);

export const StartCommandExecutionHttp = Layer.effect(
  StartCommandExecution,
  makeCodeBuildProjectHttpBinding({
    tag: "AWS.CodeBuild.StartCommandExecution",
    operation: codebuild.startCommandExecution,
    actions: ["codebuild:StartCommandExecution"],
    sandboxScoped: true,
  }),
);
