/** Effect UI builds and native development, with platform-specific deployment targets. */
export * from "./EffectUI.ts";
import { layer, type EffectUIOptions } from "./EffectUI.ts";
export default (options?: { readonly effectUI?: EffectUIOptions }) => layer(options?.effectUI);
