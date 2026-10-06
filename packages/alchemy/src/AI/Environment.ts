import * as Effect from "effect/Effect";
import type { InlineDockerfile } from "../Docker/Dockerfile.ts";
import type { ImageLayer } from "../Docker/ImageLayer.ts";
import { bindIntoImageHost } from "./ImageHost.ts";

export type { ImageLayer, ImageLayerStage } from "../Docker/ImageLayer.ts";

/** A git repository checked out into an environment at image-build time. */
export interface GitSource {
  readonly kind: "git";
  /** `owner/repo` (GitHub) or a full git URL. */
  readonly repo: string;
  /** Branch, tag, or commit. @default the default branch */
  readonly ref?: string;
  /** Keep the `.git` directory so tools can diff and commit. @default true */
  readonly keepGitDir?: boolean;
}

export interface EnvironmentProps {
  /**
   * Dockerfile instructions that prepare the box — system packages,
   * toolchains, dependency installs. A string or `Dockerfile.inline`
   * content. Never interpolate secrets: it is baked into the image.
   */
  readonly setup?: string | InlineDockerfile;
  /** Source checked out into {@link workdir}. */
  readonly source?: GitSource;
  /**
   * Directory the source is checked out into, and the directory agents work
   * in. Distinct per environment, so several can share one host.
   * @default `/workspaces/<id>`
   */
  readonly workdir?: string;
  /** Environment variables baked into the image. Never put secrets here. */
  readonly env?: Record<string, string>;
}

/** What yielding an environment returns: where it lives in the host. */
export interface Environment {
  readonly id: string;
  /** The directory the environment's source lives in. Pass it as a harness `cwd`. */
  readonly workdir: string;
}

const inlineContent = (id: string, value: string | InlineDockerfile): string => {
  if (typeof value === "string") return value;
  if (typeof value.content !== "string") {
    throw new Error(
      `${id}: setup is an unresolved Output at image-build time; inline the resolved value.`,
    );
  }
  return value.content;
};

const gitUrl = (repo: string): string =>
  /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}.git` : repo;

/** The image layers an environment contributes, in cache order. */
export const environmentLayers = (id: string, props: EnvironmentProps): ImageLayer[] => {
  const workdir = props.workdir ?? `/workspaces/${id}`;
  const setup = [
    ...Object.entries(props.env ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `ENV ${k}=${JSON.stringify(v)}`),
    ...(props.setup !== undefined ? [inlineContent(id, props.setup).trim()] : []),
  ];
  const src = props.source;
  return [
    ...(setup.length > 0
      ? [{ id: `environment:${id}:setup`, stage: "setup" as const, instructions: setup.join("\n") }]
      : []),
    {
      id: `environment:${id}:source`,
      stage: "source",
      // BuildKit's git `ADD` — no git binary needed in the base image.
      instructions: src
        ? `ADD${src.keepGitDir === false ? "" : " --keep-git-dir=true"} ${gitUrl(src.repo)}${src.ref ? `#${src.ref}` : ""} ${workdir}`
        : `RUN mkdir -p ${JSON.stringify(workdir)}`,
    },
  ];
};

/**
 * A ready-to-work environment for coding agents: setup steps (system
 * packages, toolchains) and a source checkout in its own working directory.
 *
 * An environment is a binding. Yield it inside a container (or any image
 * host) and it installs itself into that host's image; yield several to put
 * several checkouts in one box. It returns its `workdir`, which you hand to
 * the harness that works in it. The host picks the base image.
 *
 * Layers build in cache order — every environment's setup, then tool and
 * harness installs, then the source checkouts — so a new commit never
 * invalidates the installs above it.
 *
 * ### Defining an environment
 * **Example:** A pnpm monorepo checked out from GitHub
 * ```typescript
 * import * as AI from "alchemy/AI";
 * import * as Dockerfile from "alchemy/Docker/Dockerfile";
 *
 * export const App = AI.Environment("App", {
 *   setup: Dockerfile.inline`
 *     RUN apt-get update && apt-get install -y ripgrep jq
 *     RUN corepack enable
 *   `,
 *   source: AI.GitSource({ repo: "alchemy-run/alchemy", ref: "main" }),
 * });
 * ```
 *
 * ### Installing environments into a container
 * **Example:** Two checkouts and Claude Code in one container
 * ```typescript
 * export default Sandbox.make(
 *   { main: import.meta.url, runtime: "node", image: "node:22-bookworm" },
 *   Effect.gen(function* () {
 *     const app = yield* App;
 *     yield* Docs;
 *     const claude = yield* Anthropic.ClaudeCodeServer("Claude", {
 *       apiKey: yield* Config.Redacted("ANTHROPIC_API_KEY"),
 *       cwd: app.workdir,
 *     });
 *     return { fetch: yield* AI.serveHarnessHttp(claude) };
 *   }),
 * );
 * ```
 *
 * @binding
 * @product Environment
 * @category AI
 */
export const Environment = (id: string, props: EnvironmentProps = {}): Effect.Effect<Environment> =>
  Effect.gen(function* () {
    yield* bindIntoImageHost(`environment:${id}`, { image: environmentLayers(id, props) });
    return { id, workdir: props.workdir ?? `/workspaces/${id}` };
  });

/**
 * A git source checked out into an {@link Environment}'s working directory
 * at image-build time. `repo` is `owner/name` for GitHub or any git URL.
 *
 * **Example:** Pin a branch
 * ```typescript
 * AI.GitSource({ repo: "alchemy-run/alchemy", ref: "main" })
 * ```
 */
export const GitSource = (props: Omit<GitSource, "kind">): GitSource => ({
  kind: "git",
  ...props,
});
