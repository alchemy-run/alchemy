/**
 * Side-effect-only module used by `Registry.probeAsyncContext` to detect
 * whether the host runtime propagates AsyncLocalStorage into the top-level
 * evaluation of a dynamically imported module.
 *
 * It MUST NOT be imported statically anywhere — the probe relies on this
 * module being evaluated exactly once, inside the probe's `storage.run`.
 * A `data:` URL module is NOT a valid substitute: Bun evaluates those
 * without the importer's async context on every version tested, so the
 * probe would report a false negative on runtimes that are fine.
 */
const key = Symbol.for("alchemy-test/async-context-probe");

((globalThis as any)[key] as (() => void) | undefined)?.();
