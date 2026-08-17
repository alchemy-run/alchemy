/**
 * `@alchemy.run/frontend-frameworks/vite` — client-only Vite integration
 * implementing framework-core's `Framework` service: one `vite build` with
 * the project's own `vite.config.*` is the whole pipeline, and the output
 * is assets-only (no server modules). [Foldkit](https://foldkit.dev) apps
 * and plain Vite SPAs deploy through this integration.
 *
 * The optional deploy target (e.g.
 * `@alchemy.run/frontend-frameworks/vite/aws`) is a pure marker for static
 * builds — only the generic `build` takeover / `finish` seams apply.
 *
 * The default export is the e2e-harness factory contract: a
 * `(options) => Layer<Framework>` function. Use {@link layer} directly for
 * the fully-typed path.
 */
import type * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type { Framework } from "../core/index.ts";
import { layer } from "./Vite.ts";

export {
  layer,
  make,
  type ResolvedViteConfigSlice,
  type ViteDevServer,
  type ViteFrameworkOptions,
  type ViteModule,
  type ViteTargetInput,
} from "./Vite.ts";

/**
 * The e2e-harness factory contract
 * (`framework: "@alchemy.run/frontend-frameworks/vite"` in `e2e.config.ts`).
 */
const factory = (): Layer.Layer<
  Framework,
  never,
  FileSystem.FileSystem | Path.Path
> => layer();

export default factory;
