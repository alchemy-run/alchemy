/**
 * `@alchemy.run/frontend-frameworks/sveltekit/azure` — the Azure Functions
 * deploy target for `@alchemy.run/frontend-frameworks/sveltekit`.
 *
 * `Azure.Website.SvelteKit` selects this target. It reuses the Node
 * target's build (kit's Vite build in a child process, the in-memory Node
 * adapter, the rolldown re-bundle of kit's server into `dist/server`) and
 * replaces the listening wrapper with `serve-azure.mjs`, a Fetch module
 * (`export default { fetch }`) that `Azure.Functions.Function` bundles.
 *
 * Front Door serves the client directory (client assets and prerendered
 * pages) from Blob Storage and sends every other path to the Function.
 * Kit's server answers `404` for a prerendered route, and Blob Storage
 * cannot map `/about` to `about.html`. So the entry carries the list of
 * HTML files in the client directory: a `GET` or `HEAD` for one of those
 * routes is fetched from the site's own host at the file's path (a Front
 * Door asset route, so Blob Storage answers it) before kit runs.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeAzureTarget } from "../core/AzureServe.ts";
import type { BuildOutput } from "../core/BuildOutput.ts";
import { DeployTargetError } from "../core/DeployTarget.ts";
import type { NodeServeHandler } from "../core/NodeServe.ts";
import { makeNodeTarget, type SvelteKitNodeTargetConfig } from "./node.ts";
import type { SvelteKitTarget } from "./SvelteKit.ts";

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "azure", message, cause });

/**
 * Route pathname → file path (both URL pathnames) for every `.html` file
 * under `clientDirectory`: `about.html` serves `/about`, `docs/index.html`
 * serves `/docs` and `/docs/`, `index.html` serves `/`. A `name.html` file
 * wins over `name/index.html` for `/name` (kit's default
 * `trailingSlash: "never"` writes the former).
 */
export const prerenderedPages = Effect.fn(function* (clientDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = (yield* fs.readDirectory(clientDirectory, { recursive: true }))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => file.endsWith(".html"))
    .sort();
  const pages: Record<string, string> = {};
  const encode = (file: string) => `/${file.split("/").map(encodeURIComponent).join("/")}`;
  for (const file of files) {
    const stat = yield* fs.stat(path.join(clientDirectory, file));
    if (stat.type !== "File") continue;
    if (file === "index.html" || file.endsWith("/index.html")) {
      const route = `/${file.slice(0, -"index.html".length)}`;
      pages[route] ??= encode(file);
      if (route !== "/") pages[route.slice(0, -1)] ??= encode(file);
    } else {
      pages[`/${file.slice(0, -".html".length)}`] = encode(file);
    }
  }
  return pages;
});

/**
 * Wrap kit's Fetch handler expression: a `GET`/`HEAD` for a route in
 * `pages` is fetched from the request's own origin at the page's file path,
 * falling through to kit when that fetch fails or does not answer `200`.
 */
export const withPrerenderedPages = (
  handler: NodeServeHandler,
  pages: Record<string, string>,
): NodeServeHandler => ({
  kind: "fetch",
  imports: handler.imports,
  expr: `((handle, pages) => async (request) => {
  if (request.method === "GET" || request.method === "HEAD") {
    const url = new URL(request.url);
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch {}
    const file = pathname === undefined || !Object.hasOwn(pages, pathname) ? undefined : pages[pathname];
    if (file !== undefined) {
      url.pathname = file;
      url.search = "";
      try {
        const page = await fetch(url, { method: request.method, redirect: "manual" });
        if (page.status === 200) {
          const headers = new Headers();
          for (const name of ["content-type", "cache-control", "etag", "last-modified"]) {
            const value = page.headers.get(name);
            if (value !== null) headers.set(name, value);
          }
          return new Response(page.body, { status: 200, headers });
        }
        await page.body?.cancel();
      } catch (error) {
        console.error("Prerendered page fetch failed", url.href, error);
      }
    }
  }
  return handle(request);
})(${handler.expr}, ${JSON.stringify(pages)})`,
});

/** Add the prerendered-page lookup to a Node build's Fetch handler (no-op without HTML files). */
const addPrerenderedPages = (output: BuildOutput) =>
  Effect.gen(function* () {
    const handler = output.nodeServe?.handler;
    if (output.clientDirectory === undefined || handler === undefined) return output;
    if (handler.kind !== "fetch") {
      return yield* fail(`Expected kit's Fetch handler, got a "${handler.kind}" handler`);
    }
    const pages = yield* prerenderedPages(output.clientDirectory).pipe(
      Effect.mapError((cause) => fail("Failed to list the prerendered pages", cause)),
    );
    if (Object.keys(pages).length === 0) return output;
    return {
      ...output,
      nodeServe: { ...output.nodeServe, handler: withPrerenderedPages(handler, pages) },
    } satisfies BuildOutput;
  });

/** Kit's SSR served by an Azure Functions Fetch handler; prerendered pages come from Blob Storage. */
export const makeSvelteKitAzureTarget = (config?: SvelteKitNodeTargetConfig): SvelteKitTarget => {
  const node = makeNodeTarget(config);
  return makeAzureTarget({
    ...node,
    build: (context) => node.build!(context).pipe(Effect.flatMap(addPrerenderedPages)),
    finish: (output, context) =>
      node.finish!(output, context).pipe(Effect.flatMap(addPrerenderedPages)),
  });
};

/**
 * The deploy-target module contract (`resolveDeployTarget` accepts the
 * default export — or the named `target` export — as a value or factory).
 */
export const target = makeSvelteKitAzureTarget;

export default target;
