import type * as SVC from "@distilled.cloud/aws/codebuild";
import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCodeBuildProjectHttpBinding } from "./BindingHttp.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:ListCommandExecutionsForSandbox` — lists
 * the command executions run in a sandbox of the bound project.
 * ### Sandboxes
 * **Example:** List Command Executions
 * ```typescript
 * const listCommandExecutions = yield* AWS.CodeBuild.ListCommandExecutionsForSandbox(project);
 *
 * const { commandExecutions } = yield* listCommandExecutions({ sandboxId });
 * ```
 *
 * @binding
 */
export interface ListCommandExecutionsForSandbox extends Binding.Service<
  ListCommandExecutionsForSandbox,
  "AWS.CodeBuild.ListCommandExecutionsForSandbox",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (
      request: SVC.ListCommandExecutionsForSandboxInput,
    ) => Effect.Effect<
      SVC.ListCommandExecutionsForSandboxOutput,
      SVC.ListCommandExecutionsForSandboxError
    >
  >
> {}
export const ListCommandExecutionsForSandbox = Binding.Service<ListCommandExecutionsForSandbox>(
  "AWS.CodeBuild.ListCommandExecutionsForSandbox",
);

export const ListCommandExecutionsForSandboxHttp = Layer.effect(
  ListCommandExecutionsForSandbox,
  makeCodeBuildProjectHttpBinding({
    tag: "AWS.CodeBuild.ListCommandExecutionsForSandbox",
    operation: codebuild.listCommandExecutionsForSandbox,
    actions: ["codebuild:ListCommandExecutionsForSandbox"],
    sandboxScoped: true,
  }),
);
