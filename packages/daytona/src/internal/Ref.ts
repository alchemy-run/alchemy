import type * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";

/**
 * A prop that takes another resource, or a stub with the attributes it
 * needs (`{ name }`, `{ volumeId }`). Users pass the declaration itself.
 */
export type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * A `Ref` prop as lifecycle operations see it. The engine resolves
 * resource-valued props to their attributes before `diff`, `reconcile`
 * and the other lifecycle operations run, so the value is always plain.
 */
export const resolved = <T>(ref: Ref<T>): T => ref as T;
