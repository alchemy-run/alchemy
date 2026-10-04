/**
 * A class the Worker's bundle re-exports by name from another module, as it
 * is: a native `DurableObject`, a Container-backed Durable Object or a
 * `WorkerEntrypoint` that has no Effect form. The stack names the module and
 * never imports it, so a class built on `cloudflare:workers` stays out of the
 * plan, which runs outside workerd. Register it with
 * `worker.export(className, Cloudflare.Workers.nativeExport(module))`; the
 * module must export the class under that name. Bind it like any other class
 * the Worker hosts, e.g. `env: { NAME: Cloudflare.DurableObject("NAME", { className }) }`.
 */
export interface NativeExport {
  readonly kind: "native";
  readonly module: string;
}

export const nativeExport = (module: string): NativeExport => ({
  kind: "native",
  module,
});

export const isNativeExport = (value: unknown): value is NativeExport =>
  typeof value === "object" &&
  value !== null &&
  (value as { kind?: unknown }).kind === "native" &&
  typeof (value as { module?: unknown }).module === "string";
