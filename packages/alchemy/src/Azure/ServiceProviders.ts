import type * as Layer from "effect/Layer";

/**
 * What every `src/Azure/<Service>/Providers.ts` exports. `resources` lists the
 * service's Resource classes; `layers()` builds their provider layers in ONE
 * `Layer.mergeAll` call (keep it under ~90 entries — split into nested
 * `Layer.mergeAll` groups beyond that).
 */
export interface ServiceProviders {
  readonly resources: ReadonlyArray<unknown>;
  readonly layers: () => Layer.Layer<any, any, any>;
}
