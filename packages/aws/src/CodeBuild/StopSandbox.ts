import type * as SVC from "@distilled.cloud/aws/codebuild";
import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCodeBuildProjectHttpBinding } from "./BindingHttp.ts";
import type { Project } from "./Project.ts";

/**
 * Runtime binding for `codebuild:StopSandbox` — stops a running sandbox of
 * the bound project by sandbox id.
 * ### Sandboxes
 * **Example:** Stop a Sandbox
 * ```typescript
 * const stopSandbox = yield* AWS.CodeBuild.StopSandbox(project);
 *
 * yield* stopSandbox({ id: sandboxId });
 * ```
 *
 * @binding
 */
export interface StopSandbox extends Binding.Service<
  StopSandbox,
  "AWS.CodeBuild.StopSandbox",
  <P extends Project>(
    project: P,
  ) => Effect.Effect<
    (request: SVC.StopSandboxInput) => Effect.Effect<SVC.StopSandboxOutput, SVC.StopSandboxError>
  >
> {}
export const StopSandbox = Binding.Service<StopSandbox>("AWS.CodeBuild.StopSandbox");

export const StopSandboxHttp = Layer.effect(
  StopSandbox,
  makeCodeBuildProjectHttpBinding({
    tag: "AWS.CodeBuild.StopSandbox",
    operation: codebuild.stopSandbox,
    actions: ["codebuild:StopSandbox"],
    sandboxScoped: true,
  }),
);
