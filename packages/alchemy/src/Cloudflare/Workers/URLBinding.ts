import type * as Binding from "./Binding.ts";
import { makeBindingLayer } from "./BindingLayer.ts";
import { URL, type URLAccessor } from "./URL.ts";

/** The binding value produced by calling {@link URL} (declared on `env` or `yield*`-ed). */
export type URLBinding = Binding.Binding<URL["key"], URLAccessor, URL>;

/**
 * The layer that provides the Effect-native interface for the Worker's own-URL
 * binding.
 *
 * Provide it on the Worker effect (`Effect.provide(Cloudflare.Workers.URLBinding)`)
 * so that yielding {@link URL} attaches the `self_url` binding to the
 * surrounding Worker at deploy time — the provider resolves it to the Worker's
 * public URL and injects it as a plain-text env binding — and, at runtime,
 * resolves to a deferred {@link URLAccessor} (yield it to read the URL string).
 */
export const URLBinding = makeBindingLayer<URL, string, URLAccessor>(
  URL,
  (raw) => raw,
);
