/**
 * The Astro-specific deploy-target contract.
 *
 * framework-core's generic `DeployTarget` covers the platform-neutral seams
 * (`bundle`, `build`, `finish`, `serve`, opaque `config`). Astro needs one
 * framework-specific hook on top: the Astro *integration* (the adapter) that
 * gets pinned into the in-memory `AstroInlineConfig` for both `dev` and
 * `build`. Everything platform-specific — which vite plugins the adapter
 * injects, which server entrypoint it selects, how dev SSR executes — lives
 * inside that integration, so the framework half of this package never has to
 * know the platform.
 *
 * The Cloudflare implementation ships at `@alchemy.run/frameworks/astro/cloudflare`;
 * a future platform (AWS, ...) implements the same interface as a new subpath
 * without any change to the framework module.
 */
import {
  isDeployTarget,
  type DeployTarget,
  type DeployTargetInput,
} from "@alchemy.run/frameworks/core";
import type { AstroIntegration } from "astro";

export interface AstroTarget<Config = unknown> extends DeployTarget<Config> {
  /**
   * Build the Astro adapter integration pinned into the inline config
   * (`AstroInlineConfig.adapter`). Called once per `dev`/`build` operation.
   */
  readonly integration: () => AstroIntegration;
}

/**
 * How a target reaches the Astro framework module: a target value, a
 * `(config) => AstroTarget` factory, or a module specifier resolved from the
 * *project's* `node_modules` (whose `default` — or named `target` — export is
 * the value or factory).
 */
export type AstroTargetInput<Config = unknown> = DeployTargetInput<
  AstroTarget<Config>,
  Config
>;

/**
 * The default target module: the Cloudflare implementation shipped by this
 * package, resolved from the project's own dependency tree.
 */
export const DEFAULT_TARGET_SPECIFIER =
  "@alchemy.run/frameworks/astro/cloudflare";

/** Structural guard: a `DeployTarget` carrying the Astro `integration` hook. */
export const isAstroTarget = (value: unknown): value is AstroTarget =>
  isDeployTarget(value) &&
  typeof (value as { integration?: unknown }).integration === "function";
