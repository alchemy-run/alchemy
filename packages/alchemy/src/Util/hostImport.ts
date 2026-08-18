/**
 * The ONLY fully-dynamic `import()` in the codebase — every host-only
 * module (plan-time engine machinery, dev-sidecar runtimes, bundlers)
 * is loaded through this seam so that NO static edge to it exists in
 * the module graph.
 *
 * Why: user-importable surface (constructs, capabilities, `alchemy/Serve`)
 * is compiled by FOREIGN bundlers — Turbopack inside `next dev`/`next
 * build`, OpenNext's esbuild pass, the framework vite builds — which must
 * parse every module they can statically reach. The host-only graph
 * bottoms out in native binaries (`workerd`, `esbuild`, `rolldown`,
 * `sharp`) that no bundler can parse. A LITERAL dynamic import
 * (`import("./x.ts")`, `import("rolldown")`) is still a static edge —
 * bundlers resolve and parse the target for code-splitting. Passing the
 * specifier through this function boundary is not: no bundler performs
 * interprocedural constant propagation into `import()`, so the walk
 * stops here.
 *
 * At runtime on the host (bun/node — the only place these paths execute)
 * the import resolves normally.
 *
 * `base` handles module-relative specifiers: pass `import.meta.url` and
 * a `"./sibling.ts"` specifier; the URL is assembled HERE so call sites
 * never contain the `new URL(literal, import.meta.url)` pattern bundlers
 * special-case for asset detection.
 *
 * Guarded by `test/Cloudflare/GraphHygiene.test.ts`, which walks the
 * static graph from the public barrels and fails on any reachable
 * native/host-only module.
 */
export const hostImport = <T>(specifier: string, base?: string): Promise<T> =>
  import(
    /* @vite-ignore */ /* webpackIgnore: true */
    base === undefined ? specifier : new URL(specifier, base).href
  ) as Promise<T>;
