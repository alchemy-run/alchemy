import * as BuildPlan from "@alchemy.run/docker/BuildPlan";
import * as DockerfileParser from "@alchemy.run/docker/DockerfileParser";
import * as Effect from "effect/Effect";
import type { ImageBuildSpec } from "./ImageBuild.ts";

/*
 * Deploy-time image planning. Kept out of ImageBuild.ts because
 * `@alchemy.run/docker/BuildPlan` imports the bundler, which must never
 * reach a runtime bundle.
 */

/**
 * What Modal's image builder runs. It isn't Docker: it ignores `USER`
 * (containers run as root), doesn't implement `EXPOSE`, `HEALTHCHECK`,
 * `LABEL`, `ONBUILD`, `STOPSIGNAL` or `VOLUME`, has no BuildKit mounts, and
 * builds `linux/amd64` images. A Dockerfile outside this fails at plan with
 * the offending lines.
 */
export const MODAL_CAPABILITIES: BuildPlan.Capabilities = {
  target: "Modal.Image",
  multiStage: false,
  heredocs: false,
  runMounts: false,
  platforms: ["linux/amd64"],
  instructions: {
    USER: "ignored",
    EXPOSE: "unsupported",
    HEALTHCHECK: "unsupported",
    LABEL: "unsupported",
    ONBUILD: "unsupported",
    STOPSIGNAL: "unsupported",
    VOLUME: "unsupported",
  },
};

/**
 * Lower a {@link BuildPlan.BuildPlan} to Modal's build inputs: the plan's
 * Dockerfile as commands, every context file it reads, and its build args.
 * `extra` lines (already checked) follow the plan's instructions.
 */
export const lowerPlan = Effect.fn(function* (
  plan: BuildPlan.BuildPlan,
  extra: ReadonlyArray<string> = [],
) {
  const contextFiles = yield* Effect.forEach(plan.files, (file) =>
    Effect.map(BuildPlan.readContextFile(file), (data) => ({
      filename: file.path,
      data,
      mode: file.mode,
    })),
  );
  return {
    commands: [...BuildPlan.renderLines(plan), ...extra],
    contextFiles,
    buildArgs: plan.args,
  } satisfies ImageBuildSpec;
});

/**
 * Parse and check Dockerfile lines appended to a plan (`commands`), the way
 * {@link BuildPlan.plan} checks the Dockerfile itself.
 */
export const checkCommands = Effect.fn(function* (commands: ReadonlyArray<string>) {
  if (commands.length === 0) return [] as string[];
  const parsed = yield* DockerfileParser.parse(`FROM scratch\n${commands.join("\n")}\n`);
  const { violations } = BuildPlan.check(parsed, MODAL_CAPABILITIES, "linux/amd64");
  if (violations.length > 0) {
    return yield* new BuildPlan.UnsupportedDockerfile({
      target: MODAL_CAPABILITIES.target,
      violations,
      message: [
        `${MODAL_CAPABILITIES.target} cannot build these commands:`,
        ...violations.map((v) => `  ${v.instruction}: ${v.reason}`),
      ].join("\n"),
    });
  }
  return DockerfileParser.renderLines(parsed).slice(1);
});
