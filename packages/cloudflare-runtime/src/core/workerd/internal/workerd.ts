import { createRequire } from "node:module";

/**
 * The `workerd` npm package locates its native binary at module init
 * (`generateBinPath` → `downloadedBinPath` → `require.resolve`). That must
 * not run inside a Worker isolate: there is no `require.resolve`, so
 * startup dies with `TypeError: e.resolve is not a function` (#1443).
 *
 * Load it only when Node actually needs to spawn the binary.
 */
export interface WorkerdPackage {
  readonly bin: string;
  readonly compatibilityDate: string;
  readonly version: string;
}

let cached: WorkerdPackage | undefined;

export const loadWorkerd = (): WorkerdPackage => {
  if (cached !== undefined) {
    return cached;
  }
  // Concatenate the specifier so bundlers cannot rewrite this to a static
  // `import "workerd"` (which would run `generateBinPath` at Worker isolate
  // init even when this function is never called).
  const Workerd = createRequire(import.meta.url)("work" + "erd") as {
    default: string | { default: string };
    compatibilityDate: string;
    version: string;
  };
  cached = {
    bin:
      typeof Workerd.default === "string"
        ? Workerd.default
        : Workerd.default.default,
    compatibilityDate: Workerd.compatibilityDate,
    version: Workerd.version,
  };
  return cached;
};
