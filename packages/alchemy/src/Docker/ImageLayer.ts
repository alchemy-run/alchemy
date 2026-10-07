/**
 * Host-agnostic image-layer contributions.
 *
 * An {@link ImageLayer} is a Dockerfile fragment that a *binding* contributes
 * to the image of the host it is yielded in — an environment installing its
 * toolchain and source checkout, or a coding-agent harness installing its
 * CLI. Container hosts (Cloudflare Containers today; ECS tasks and MicroVM
 * images next) render the layers between their base image and their own
 * program layers. Layers are deduplicated by `id`, so two bindings
 * installing the same thing produce one layer.
 *
 * Layers render in {@link ImageLayerStage} order for build caching:
 * `setup` (system packages, toolchains) → `install` (tools, harness CLIs) →
 * `source` (checkouts, which change most often and so never invalidate the
 * installs above them). Within a stage, layers keep binding order.
 */

import type { ImageContextSource } from "./ImageContext.ts";

/** Where a layer sits in the image, for build caching. */
export type ImageLayerStage = "setup" | "install" | "source";

/** A Dockerfile fragment a binding contributes to its host's image. */
export interface ImageLayer {
  /** Stable identity used for deduplication (e.g. `claude-code@2.1`). */
  readonly id: string;
  /** Dockerfile instructions (`RUN …`, `ENV …`, `ADD <git url>`). No `FROM`, no context `COPY`. */
  readonly instructions: string;
  /** @default "install" */
  readonly stage?: ImageLayerStage;
  /**
   * Files the layer's instructions `COPY` from the build context (inline
   * files, host directories, git checkouts). The host materializes them
   * before building.
   */
  readonly context?: ReadonlyArray<ImageContextSource>;
  /**
   * The npm packages this layer installs, when it is an npm install — so a
   * program run outside the image (`alchemy dev` on the host) can install
   * the same `app` packages next to itself.
   */
  readonly npm?: { readonly packages: ReadonlyArray<string>; readonly into: "global" | "app" };
}

const STAGE_ORDER: Record<ImageLayerStage, number> = { setup: 0, install: 1, source: 2 };

/**
 * Deduplicate layers by `id` (first occurrence wins) and order them by
 * stage, keeping binding order within a stage.
 */
export const dedupeImageLayers = (layers: ReadonlyArray<ImageLayer>): ImageLayer[] => {
  const seen = new Set<string>();
  const out: ImageLayer[] = [];
  for (const layer of layers) {
    if (seen.has(layer.id)) continue;
    seen.add(layer.id);
    out.push(layer);
  }
  return out
    .map((layer, index) => ({ layer, index }))
    .sort(
      (a, b) =>
        STAGE_ORDER[a.layer.stage ?? "install"] - STAGE_ORDER[b.layer.stage ?? "install"] ||
        a.index - b.index,
    )
    .map(({ layer }) => layer);
};

/**
 * Render binding-contributed layers on top of a host's base preamble
 * (`FROM …` plus any host steps). The host appends its program layers after.
 */
export const renderImageLayers = (options: {
  /** The host's base: a `FROM …` line plus any steps. */
  readonly preamble: string;
  readonly layers: ReadonlyArray<ImageLayer>;
}): string =>
  [
    options.preamble.trimEnd(),
    ...dedupeImageLayers(options.layers).map(
      (layer) => `# layer: ${layer.id}\n${layer.instructions.trim()}`,
    ),
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
