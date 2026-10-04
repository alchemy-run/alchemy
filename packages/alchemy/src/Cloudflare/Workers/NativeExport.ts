/**
 * A class the Worker's bundle re-exports by name from another module, as it
 * is: a native `DurableObject`, a Container-backed Durable Object or a
 * `WorkerEntrypoint` that has no Effect form. The stack names the module and
 * never imports it, so a class built on `cloudflare:workers` stays out of the
 * plan, which runs outside workerd.
 *
 * Register it with `worker.export(className, Cloudflare.Workers.nativeExport(module))`.
 * The Worker's generated entry then contains
 * `export { className } from "module";`, so the module must export the class
 * under that name. `module` is resolved like any import of the generated
 * entry: use a package specifier (`"@app/agent/sandbox"`) or an absolute
 * path. A relative path (`"./sandbox.ts"`) is rejected with a build error,
 * because it would resolve against the generated entry rather than the
 * Worker's project. A package that cannot be resolved from the Worker's
 * project fails the build.
 *
 * Bind the class like any other class the Worker hosts, e.g.
 * `env: { NAME: Cloudflare.DurableObject("NAME", { className }) }`.
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
  "kind" in value &&
  value.kind === "native" &&
  "module" in value &&
  typeof value.module === "string";
