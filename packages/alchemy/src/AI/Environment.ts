import type { GitImageSource, ImageEnvironment } from "../Docker/ImageEnvironment.ts";

export type { GitImageSource, ImageEnvironment, ImageLayer } from "../Docker/ImageEnvironment.ts";

/**
 * A ready-to-work environment for a coding agent: the base image, setup
 * steps (system packages, dependency installs), and a source checkout. Pass
 * it as a container's `environment`; harness servers yielded inside the
 * container (`Anthropic.ClaudeCodeServer`, `OpenAI.CodexServer`, …) layer
 * their own installs on top.
 *
 * The environment is plain data. Layers build in a fixed order so the
 * source — which changes most — never invalidates the tool installs:
 * base → setup → harness installs → source checkout.
 *
 * ### Defining an environment
 * **Example:** A pnpm monorepo checked out from GitHub
 * ```typescript
 * import * as AI from "alchemy/AI";
 * import * as Dockerfile from "alchemy/Docker/Dockerfile";
 *
 * export const Workspace = AI.Environment({
 *   base: "node:22-bookworm",
 *   setup: Dockerfile.inline`
 *     RUN apt-get update && apt-get install -y ripgrep jq
 *     RUN corepack enable
 *   `,
 *   source: AI.GitSource({ repo: "alchemy-run/alchemy", ref: "main" }),
 *   workdir: "/workspace",
 * });
 * ```
 *
 * ### Using it in a container
 * **Example:** Claude Code in a Cloudflare Container
 * ```typescript
 * export default Sandbox.make(
 *   { main: import.meta.url, environment: Workspace },
 *   Effect.gen(function* () {
 *     const claude = yield* Anthropic.ClaudeCodeServer("Claude", {});
 *     // ...
 *   }),
 * );
 * ```
 */
export const Environment = (props: ImageEnvironment): ImageEnvironment => props;

/**
 * A git source checked out into an {@link Environment}'s working directory
 * at image-build time (BuildKit git `ADD` — the base image needs no `git`).
 * `repo` is `owner/name` for GitHub or any git URL.
 *
 * **Example:** Pin a branch
 * ```typescript
 * AI.GitSource({ repo: "alchemy-run/alchemy", ref: "main" })
 * ```
 */
export const GitSource = (props: Omit<GitImageSource, "kind">): GitImageSource => ({
  kind: "git",
  ...props,
});
