import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

/**
 * Write the Next.js mount (Serve/DESIGN.md) into a cloned fixture tree:
 * an optional catch-all route handler at `app/api/[[...slug]]/route.ts`
 * calling `mount(Site, { routes })` — HTTP composition is user code, and
 * writing it at test time lets each test mount ITS site module (the
 * fixture carries several: `src/site.ts`, `src/site-hmr.ts`).
 *
 * `serveSpecifier` defaults to the published `alchemy/Serve` subpath (what
 * a real app writes; resolves through node conditions to the built `lib/`).
 * The hmr test overrides it with a relative path into `packages/alchemy/src`
 * so the mount shares one module graph with its relative-import site module
 * (see `hmrSiteSource` in Nextjs.local.test.ts).
 */
/**
 * Shadow `@alchemy.run/cloudflare-runtime` with an inert stub package in
 * the CLONE's `node_modules`, so OpenNext's server esbuild never bundles
 * the local-runtime engine graph.
 *
 * Why: the alchemy construct graph carries GUARDED dynamic imports of the
 * local-runtime machinery (`RuntimeImport.ts` — computed specifiers +
 * `webpackIgnore`, host-side only). Turbopack honors the ignore comment
 * and emits them as literal runtime `import()`s — but OpenNext's server
 * esbuild pass (`bundle: true`) resolves literal dynamic imports anyway,
 * dragging in the engine graph whose distilled imports land on raw
 * `src/*.ts` (the `workerd` condition + distilled's tsconfig `paths`),
 * which OpenNext's ContentUpdater forces through the `js` loader
 * (upstream limitation). A clone-local stub package wins module
 * resolution from anywhere inside the clone (including `.open-next/`),
 * while the ENGINE's own imports resolve from `packages/alchemy` and
 * never see it. Mirrors the astro fetchable-plugin's NODE_STUBS.
 */
export const stubCloudflareRuntimeForNextBundling = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  rootDir: string,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const pkgDir = path.join(
      rootDir,
      "node_modules",
      "@alchemy.run",
      "cloudflare-runtime",
    );
    yield* fs.makeDirectory(pkgDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(pkgDir, "package.json"),
      JSON.stringify(
        {
          name: "@alchemy.run/cloudflare-runtime",
          version: "0.0.0-next-bundling-stub",
          type: "module",
          exports: { ".": "./inert.mjs", "./*": "./inert.mjs" },
        },
        null,
        2,
      ),
    );
    yield* fs.writeFileString(
      path.join(pkgDir, "inert.mjs"),
      [
        `// Inert stand-in (see stubCloudflareRuntimeForNextBundling in`,
        `// NextjsMount.ts): every export tolerates arbitrary property chains`,
        `// and throws only when actually invoked — loud failure polarity if a`,
        `// host-side code path is ever reached inside the Worker.`,
        `const inert = new Proxy(function inert() {}, {`,
        `  get: (_t, prop) => (prop === Symbol.toPrimitive ? () => "" : inert),`,
        `  apply: () => {`,
        `    throw new Error(`,
        `      "@alchemy.run/cloudflare-runtime is host-side machinery and is " +`,
        `        "not available inside the worker (stubbed for Next bundling)",`,
        `    );`,
        `  },`,
        `});`,
        `export default inert;`,
        `export const layerRuntime = inert;`,
        `export const Runtime = inert;`,
        `export const open = inert;`,
        `export const SERVICE_D1 = inert;`,
        `export const WorkerProxy = inert;`,
        ``,
      ].join("\n"),
    );
  });

export const writeNextjsMount = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  rootDir: string,
  siteFile: string,
  options?: {
    routes?: readonly string[];
    serveSpecifier?: string;
  },
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const routes = options?.routes ?? ["/api/*", "!/api/hello"];
    const serveSpecifier = options?.serveSpecifier ?? "alchemy/Serve";
    const routeDir = path.join(rootDir, "app", "api", "[[...slug]]");
    yield* fs.makeDirectory(routeDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(routeDir, "route.ts"),
      [
        `/**`,
        ` * The mount (Serve/DESIGN.md) — on Next.js a route file owns HTTP`,
        ` * composition: this optional catch-all claims the mount's routes`,
        ` * (Next already prefers the more-specific route files; the exclusion`,
        ` * globs keep the claim honest for callers of this handler).`,
        ` */`,
        `import { mount } from ${JSON.stringify(serveSpecifier)};`,
        `import Site from ${JSON.stringify(`../../../src/${siteFile}`)};`,
        ``,
        `const site = mount(Site, { routes: ${JSON.stringify(routes)} });`,
        ``,
        `// Route handlers must never prerender at build time — there is no`,
        `// backend (and no stack markers) inside \`next build\`.`,
        `export const dynamic = "force-dynamic";`,
        ``,
        `const handler = async (req: Request): Promise<Response> =>`,
        `  (await site.fetch(req)) ?? new Response("Not Found", { status: 404 });`,
        ``,
        `export {`,
        `  handler as DELETE,`,
        `  handler as GET,`,
        `  handler as HEAD,`,
        `  handler as OPTIONS,`,
        `  handler as PATCH,`,
        `  handler as POST,`,
        `  handler as PUT,`,
        `};`,
        ``,
      ].join("\n"),
    );
  });
