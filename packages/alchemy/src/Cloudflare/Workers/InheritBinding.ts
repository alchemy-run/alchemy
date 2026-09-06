import type * as Binding from "./Binding.ts";
import { makeBindingLayer } from "./BindingLayer.ts";
import { Inherit, type InheritAccessor } from "./Inherit.ts";

/** The binding value produced by calling {@link Inherit} (declared on `env` or `yield*`-ed). */
export type InheritBinding = Binding.Binding<
  Inherit["key"],
  InheritAccessor,
  Inherit
>;

/**
 * The layer that provides the Effect-native interface for Cloudflare Worker
 * binding inheritance.
 *
 * Provide it on the Worker effect (`Effect.provide(Cloudflare.Workers.InheritBinding)`)
 * so that yielding an {@link Inherit} binding attaches a value-free `inherit`
 * marker to the surrounding Worker at deploy time and, at runtime, resolves to
 * a deferred {@link InheritAccessor}.
 */
export const InheritBinding = makeBindingLayer<
  Inherit,
  unknown,
  InheritAccessor
>(Inherit, (raw) => raw);
