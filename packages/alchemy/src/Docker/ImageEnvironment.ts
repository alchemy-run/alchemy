/**
 * Host-agnostic image environments and image-layer contributions.
 *
 * An {@link ImageEnvironment} describes the box a program runs in — base
 * image, setup steps, a source checkout, the working directory — as plain,
 * state-serializable data. Container hosts (Cloudflare Containers today;
 * ECS tasks and MicroVM images next) compile it into the environment section
 * of the Dockerfile they generate around the bundled program.
 *
 * An {@link ImageLayer} is a Dockerfile fragment that a *binding* contributes
 * to its host's image — e.g. a coding-agent harness installing its CLI into
 * whatever container it is yielded in. Layers are deduplicated by `id`, so
 * two bindings installing the same tool produce one layer.
 *
 * Layer order is fixed for build caching: base → setup → contributed layers →
 * source checkout → (host-specific program layers). The source changes most
 * often, so it comes last and never invalidates the tool installs above it.
 */
import type { InlineDockerfile } from "./Dockerfile.ts";

/** A source tree checked out into the image. */
export type ImageSource = GitImageSource;

export interface GitImageSource {
  readonly kind: "git";
  /** `owner/repo` (GitHub) or a full git URL. */
  readonly repo: string;
  /** Branch, tag, or commit. @default the default branch */
  readonly ref?: string;
  /** Keep the `.git` directory so tools can diff/commit. @default true */
  readonly keepGitDir?: boolean;
}

export interface ImageEnvironment {
  /**
   * Base image (`FROM`). Exclusive with {@link dockerfile}.
   * @default the host's runtime default (e.g. `oven/bun:1`)
   */
  readonly base?: string;
  /**
   * Full inline environment preamble (carries its own `FROM`). Exclusive
   * with {@link base}.
   */
  readonly dockerfile?: InlineDockerfile;
  /**
   * Extra Dockerfile instructions after the base — system packages,
   * dependency installs. A string or `Dockerfile.inline` content.
   */
  readonly setup?: string | InlineDockerfile;
  /** Source tree checked out into {@link workdir}. */
  readonly source?: ImageSource;
  /**
   * Directory the source is checked out into, and the working directory
   * tools run in.
   * @default "/workspace"
   */
  readonly workdir?: string;
  /** Environment variables baked into the image. Never put secrets here. */
  readonly env?: Record<string, string>;
}

/** A Dockerfile fragment a binding contributes to its host's image. */
export interface ImageLayer {
  /** Stable identity used for deduplication (e.g. `claude-code@2.1`). */
  readonly id: string;
  /** Dockerfile instructions (`RUN …`, `ENV …`). No `FROM`, no context `COPY`. */
  readonly instructions: string;
}

const inlineContent = (value: string | InlineDockerfile, field: string): string => {
  if (typeof value === "string") return value;
  if (typeof value.content !== "string") {
    throw new Error(
      `environment.${field} is an unresolved Output at image-build time; inline the resolved value or break the dependency cycle.`,
    );
  }
  return value.content;
};

/** Deduplicate layers by `id`, keeping the first occurrence (binding order). */
export const dedupeImageLayers = (layers: ReadonlyArray<ImageLayer>): ImageLayer[] => {
  const seen = new Set<string>();
  const out: ImageLayer[] = [];
  for (const layer of layers) {
    if (seen.has(layer.id)) continue;
    seen.add(layer.id);
    out.push(layer);
  }
  return out;
};

const gitUrl = (repo: string): string =>
  /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}.git` : repo;

const shellQuote = (value: string) => JSON.stringify(value);

/**
 * Render the environment section of a generated Dockerfile: everything
 * before the host appends its own program layers. `defaultBase` is the
 * host's `FROM` line when the environment names no base.
 */
export const renderImageEnvironment = (options: {
  readonly environment?: ImageEnvironment;
  /** The host's preamble when no environment base is given (`FROM …` + any steps). */
  readonly defaultPreamble: string;
  readonly layers?: ReadonlyArray<ImageLayer>;
}): string => {
  const env = options.environment;
  if (env?.base !== undefined && env.dockerfile !== undefined) {
    throw new Error("environment.base and environment.dockerfile are exclusive.");
  }
  const sections: string[] = [];
  if (env?.dockerfile !== undefined)
    sections.push(inlineContent(env.dockerfile, "dockerfile").trimEnd());
  else if (env?.base !== undefined) sections.push(`FROM ${env.base.trim()}`);
  else sections.push(options.defaultPreamble.trimEnd());

  if (env?.env && Object.keys(env.env).length > 0) {
    sections.push(
      Object.entries(env.env)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `ENV ${k}=${shellQuote(v)}`)
        .join("\n"),
    );
  }
  if (env?.setup !== undefined) sections.push(inlineContent(env.setup, "setup").trim());
  for (const layer of dedupeImageLayers(options.layers ?? [])) {
    sections.push(`# layer: ${layer.id}\n${layer.instructions.trim()}`);
  }
  if (env?.source !== undefined || env?.workdir !== undefined) {
    const workdir = env.workdir ?? "/workspace";
    const src = env.source;
    if (src?.kind === "git") {
      const url = `${gitUrl(src.repo)}${src.ref ? `#${src.ref}` : ""}`;
      // BuildKit's git `ADD` — no git binary needed in the base image.
      sections.push(
        `ADD${src.keepGitDir === false ? "" : " --keep-git-dir=true"} ${url} ${workdir}`,
      );
    }
    sections.push(`ENV ALCHEMY_WORKDIR=${shellQuote(workdir)}`);
  }
  return sections.filter((s) => s.length > 0).join("\n\n");
};
