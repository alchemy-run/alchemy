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
