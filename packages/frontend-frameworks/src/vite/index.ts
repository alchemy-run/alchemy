import { layer, type ViteOptions } from "./Vite.ts";

export {
  DEFAULT_TARGET_SPECIFIER,
  layer,
  make,
  type ViteEnvironmentsOptions,
  type ViteOptions,
  type ViteTarget,
  type ViteTargetConfig,
  type ViteTargetInput,
} from "./Vite.ts";

export {
  effectMainPath,
  makeEffectDevPlugin,
  type EffectDevPluginArgs,
  type ViteEffectOptions,
} from "./effect.ts";

/**
 * The e2e-harness framework factory contract: default-export a
 * `(options) => Layer<Framework>` factory.
 */
const framework = (options?: ViteOptions) => layer(options);

export default framework;
