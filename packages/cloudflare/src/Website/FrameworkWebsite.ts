import type { AssetsConfig } from "../Workers/Assets.ts";
import type { WorkerBindingProps, WorkerProps, WorkspaceMemoOptions } from "../Workers/Worker.ts";

/**
 * Props every framework Website shares. A framework adds its own options,
 * and a custom Worker entry (`main`) where it supports one; the Worker's
 * entry, build and asset directory come from the framework's build.
 */
export interface FrameworkWebsiteProps<Bindings extends WorkerBindingProps = {}> extends Omit<
  WorkerProps<Bindings>,
  "vite" | "main" | "assets" | "source" | "script" | "bundle" | "rules"
> {
  /**
   * The framework project root. Relative paths resolve from the process
   * working directory.
   * @default process.cwd()
   */
  rootDir?: string;
  /**
   * Which files are hashed to decide whether the build re-runs. By default
   * every non-gitignored file under {@link rootDir}, the nearest
   * package-manager lockfile, and the workspace packages the build imports.
   * Narrow it with `include`/`exclude` globs, or pin the workspaces.
   */
  memo?: WorkspaceMemoOptions;
  /**
   * Static asset routing (`runWorkerFirst`, `htmlHandling`,
   * `notFoundHandling`, ...), applied over the framework's defaults.
   */
  assets?: AssetsConfig;
}
