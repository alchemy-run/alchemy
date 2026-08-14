// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * The generated Cloudflare Worker entry (`_worker.js`) for a SvelteKit build.
 *
 * A fork of `@sveltejs/adapter-cloudflare`'s `src/worker.js` with three
 * differences:
 *
 * - The `SERVER` / `MANIFEST` / `ASSETS` placeholders are templated directly
 *   with real relative import paths, so there is no publish-time prebundle or
 *   `builder.copy` string replacement.
 * - `worktop/cfw.cache` is replaced with an inline `caches.default` wrapper
 *   (same lookup/save semantics), dropping the dependency.
 * - With `notFoundHandling: "single-page-application"`, router-level
 *   not-founds on navigation-shaped requests are deferred to the assets
 *   layer (see below) so the configured `not_found_handling` governs.
 *
 * ## SPA not-found deferral (divergence from upstream)
 *
 * Upstream's `worker.js` never defers: kit's `server.respond` renders its
 * own 404 error page for unmatched routes, and the assets-layer
 * `not_found_handling` only applies to requests the worker never sees
 * (asset-layer navigations under the `Sec-Fetch-Mode: navigate` preference
 * flag) or to `env.ASSETS.fetch` misses. That leaves the configured
 * `single-page-application` fallback unreachable for navigations that DO
 * invoke the worker (e.g. plain `fetch` without `Sec-Fetch-Mode`).
 *
 * With `notFoundHandling: "single-page-application"` the shim therefore
 * defers to `env.ASSETS.fetch(req)` — where the asset worker applies the
 * configured `not_found_handling` and serves the generated `index.html`
 * fallback — when ALL of:
 *
 * - `server.respond` returned a 404, AND
 * - the request is navigation-shaped: `GET`/`HEAD` with `Accept`
 *   containing `text/html` (deliberately excluding kit data/route-resolution
 *   requests and API `fetch`es), AND
 * - no kit route *pattern* matches the pathname — the most conservative
 *   available signal that the 404 is kit's router-level "no route" error
 *   rather than an intentional endpoint- or page-produced 404 (upstream has
 *   no deferral, so there are no upstream semantics to mirror; kit marks
 *   router 404s with no header). Endpoints only exist on matched routes, so
 *   endpoint 404s are never deferred. A pattern match whose param matchers
 *   fail is treated as matched (kit's own 404 page renders), as is a 404
 *   produced by a user `handle` hook on a path that happens to match a
 *   route pattern.
 *
 * `notFoundHandling: "404-page"` keeps exact upstream behavior (no
 * deferral): upstream documents the `404.html` page as covering asset-layer
 * misses only, with router-level 404s still rendered by kit.
 *
 * The emitted module is *unbundled* — its imports reach into
 * `.svelte-kit/output/server/**` — and is the input for the rolldown pass
 * that produces the final workerd-ready modules.
 */
/**
 * The effect arm of the shim (DESIGN §6.2b) — collect-only *wrapper*
 * delivery for an effectful `Cloudflare.Website.SvelteKit`. When present,
 * the shim wraps kit's fetch handler in `alchemy/Serve/Worker`'s
 * `makeWebsiteExports`: the Effect fetch owns `routes` and dispatches
 * BEFORE the shim's pragma-cache/static-asset checks — effect responses
 * are never served from (or written to) the shim's edge cache — and only
 * requests outside the routes fall through to kit unchanged. Durable
 * Object / Workflow classes from the site's exports are re-exported as
 * bridge classes sharing the one-per-isolate layer build.
 */
export interface WorkerShimEffectOptions {
  /**
   * Absolute filesystem path of the user's site module (the impl anchor,
   * `main: import.meta.url` converted to a path). The shim re-imports the
   * Website class from here inside workerd; the rolldown finish pass
   * bundles it as one more input edge.
   */
  readonly main: string;
  /** Path globs the Effect fetch owns. @default ["/api/*"] */
  readonly routes?: ReadonlyArray<string> | undefined;
  /** Durable Object class names exported by the site's Effect program. */
  readonly durableObjects?: ReadonlyArray<string> | undefined;
  /** Workflow class names exported by the site's Effect program. */
  readonly workflows?: ReadonlyArray<string> | undefined;
  /** Stack identity baked into Workflow bridge metadata. */
  readonly stack?:
    | { readonly name: string; readonly stage: string }
    | undefined;
}

export interface WorkerShimOptions {
  /** Relative import path to kit's server entry (`.../output/server/index.js`). */
  readonly serverImport: string;
  /** Relative import path to the generated manifest module. */
  readonly manifestImport: string;
  /** Name of the static-assets binding. */
  readonly assetsBinding: string;
  /**
   * The assets-layer `not_found_handling` the build was produced for. With
   * `"single-page-application"` the shim defers router-level not-founds on
   * navigation-shaped requests to the assets binding (see the module doc);
   * any other value emits upstream-parity behavior (no deferral).
   * @default "none"
   */
  readonly notFoundHandling?:
    | "none"
    | "404-page"
    | "single-page-application"
    | undefined;
  /**
   * Effectful-Website wrapper delivery (see
   * {@link WorkerShimEffectOptions}). Absent for plain SvelteKit sites —
   * the emitted module is then byte-equivalent to the historical shim.
   */
  readonly effect?: WorkerShimEffectOptions | undefined;
}

/**
 * The SPA-deferral helper emitted ahead of the fetch handler: kit's
 * `find_route` pattern probe, minus param matchers (a pattern match with
 * failing matchers is conservatively treated as matched).
 */
const spaRouteProbe = /* js */ `
// Router-level match probe for the SPA not-found deferral: mirrors kit's
// find_route pattern test (without param matchers — a pattern match whose
// matchers fail keeps kit's own 404 rendering).
const matches_kit_route = (pathname) => {
  let path = pathname;
  if (base_path) {
    if (!path.startsWith(base_path)) return false;
    path = path.slice(base_path.length) || '/';
  }
  for (const route of manifest._.routes) {
    if (route.pattern.test(path)) return true;
  }
  return false;
};
`;

const spaDeferral = (assetsBinding: string): string => /* js */ `
      // not_found_handling: "single-page-application" — defer router-level
      // not-founds on navigation-shaped requests (GET/HEAD accepting
      // text/html) to the assets layer, which serves the generated
      // index.html fallback. Intentional endpoint/page 404s (matched
      // routes) are never deferred.
      if (
        res.status === 404 &&
        (req.method === 'GET' || req.method === 'HEAD') &&
        (req.headers.get('accept') || '').includes('text/html') &&
        !matches_kit_route(pathname)
      ) {
        res = await env.${assetsBinding}.fetch(req);
      }
`;

/** Imports the effect arm adds ahead of the shared shim internals. */
const effectImports = (effect: WorkerShimEffectOptions): string => {
  const hasDo = (effect.durableObjects?.length ?? 0) > 0;
  const hasWf = (effect.workflows?.length ?? 0) > 0;
  return [
    `import { WorkerEntrypoint${hasDo ? ", DurableObject" : ""}${hasWf ? ", WorkflowEntrypoint" : ""} } from 'cloudflare:workers';`,
    `import { makeWebsiteExports${hasDo ? ", DurableObjectBridge" : ""} } from "alchemy/Serve/Worker";`,
    ...(hasWf
      ? [`import { makeWorkflowBridge } from "alchemy/Cloudflare";`]
      : []),
    `import __alchemy_site from ${JSON.stringify(effect.main)};`,
  ].join("\n");
};

/**
 * The effect arm's exports: the `makeWebsiteExports` wrapper as the default
 * export (Effect fetch for `routes` — dispatched before the pragma-cache /
 * asset checks inside `kit_handler`, authoritative within the routes — kit
 * serves only paths outside them; full non-fetch handler surface from the
 * Worker bridge dispatch), plus DO / Workflow bridge class re-exports
 * sharing the one-per-isolate build.
 */
const effectExports = (effect: WorkerShimEffectOptions): string => {
  const doClasses = effect.durableObjects ?? [];
  const wfClasses = effect.workflows ?? [];
  return [
    "// Effectful Website wrapper (alchemy auto-inject tier): the Effect",
    "// fetch owns the routes below and runs BEFORE kit_handler's",
    "// pragma-cache/asset checks — effect responses are never edge-cached",
    "// by the shim. Only paths outside the routes fall through to kit.",
    "export default makeWebsiteExports(WorkerEntrypoint, {",
    "  site: __alchemy_site,",
    ...(effect.routes !== undefined
      ? [`  routes: ${JSON.stringify(effect.routes)},`]
      : []),
    "  framework: () => Promise.resolve({ default: kit_handler }),",
    "});",
    ...(doClasses.length > 0
      ? [
          "const __alchemyDurableObjectBridge = DurableObjectBridge(DurableObject, { site: __alchemy_site });",
          ...doClasses.map(
            (name) =>
              `export class ${name} extends __alchemyDurableObjectBridge(${JSON.stringify(name)}) {}`,
          ),
        ]
      : []),
    ...(wfClasses.length > 0
      ? [
          `const __alchemyWorkflowBridge = makeWorkflowBridge(WorkflowEntrypoint, { entrypoint: __alchemy_site, stack: { name: ${JSON.stringify(effect.stack?.name ?? "")}, stage: ${JSON.stringify(effect.stack?.stage ?? "")} } });`,
          ...wfClasses.map(
            (name) =>
              `export class ${name} extends __alchemyWorkflowBridge(${JSON.stringify(name)}) {}`,
          ),
        ]
      : []),
  ].join("\n");
};

export const generateWorkerShim = (options: WorkerShimOptions): string =>
  /* js */ `
import { Server } from ${JSON.stringify(options.serverImport)};
import { manifest, prerendered, base_path } from ${JSON.stringify(options.manifestImport)};
import { env } from 'cloudflare:workers';
${options.effect !== undefined ? effectImports(options.effect) : ""}

const server = new Server(manifest);

const app_path = \`/\${manifest.appPath}\`;
const immutable = \`\${app_path}/immutable/\`;
const version_file = \`\${app_path}/version.json\`;

// Inline pragma-cache over \`caches.default\` (replaces the upstream
// adapter's external cache dependency).
const cache = caches.default;

const is_cacheable = (res) => {
  if (res.status === 206) return false;
  const vary = res.headers.get('vary') || '';
  if (vary.includes('*')) return false;
  const control = res.headers.get('cache-control') || '';
  if (/(private|no-cache|no-store)/i.test(control)) return false;
  return true;
};

const cache_lookup = async (req) => {
  const is_head = req.method === 'HEAD';
  if (is_head) req = new Request(req, { method: 'GET' });
  let res = await cache.match(req);
  if (is_head && res) res = new Response(null, res);
  return res;
};

const cache_save = (req, res, ctx) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && is_cacheable(res)) {
    if (res.headers.has('set-cookie')) {
      res = new Response(res.body, res);
      res.headers.append('cache-control', 'private=Set-Cookie');
    }
    ctx.waitUntil(cache.put(req, res.clone()));
  }
  return res;
};

${options.notFoundHandling === "single-page-application" ? spaRouteProbe : ""}
/**
 * We don't know the origin until we receive a request, but that's guaranteed
 * to happen before we call \`read\`.
 */
let origin;

const initialized = server.init({
  env,
  read: async (file) => {
    const url = \`\${origin}/\${file}\`;
    const response = await env.${options.assetsBinding}.fetch(url);
    if (!response.ok) {
      throw new Error(\`read(...) failed: could not fetch \${url} (\${response.status})\`);
    }
    return response.body;
  },
});

const kit_handler = {
  async fetch(req, env, ctx) {
    if (!origin) {
      origin = new URL(req.url).origin;
    }

    // always await initialization to prevent race condition with concurrent requests
    await initialized;

    // skip cache if "cache-control: no-cache" in request
    let pragma = req.headers.get('cache-control') || '';
    let res = !pragma.includes('no-cache') && (await cache_lookup(req));
    if (res) return res;

    let { pathname, search } = new URL(req.url);
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // ignore invalid URI
    }

    const stripped_pathname = pathname.replace(/\\/$/, '');

    // files in /static, the service worker, and Vite-imported server assets
    let is_static_asset = false;
    const filename = stripped_pathname.slice(base_path.length + 1);
    if (filename) {
      is_static_asset =
        manifest.assets.has(filename) || manifest.assets.has(filename + '/index.html');
    }

    let location = pathname.at(-1) === '/' ? stripped_pathname : pathname + '/';

    if (
      is_static_asset ||
      prerendered.has(pathname) ||
      pathname === version_file ||
      pathname.startsWith(immutable)
    ) {
      res = await env.${options.assetsBinding}.fetch(req);
    } else if (location && prerendered.has(location)) {
      // trailing slash redirect for prerendered pages
      if (search) location += search;
      res = new Response('', { status: 308, headers: { location } });
    } else {
      // dynamically-generated pages
      res = await server.respond(req, {
        platform: { env, ctx, caches, cf: req.cf },
        getClientAddress() {
          return req.headers.get('cf-connecting-ip');
        },
      });
${options.notFoundHandling === "single-page-application" ? spaDeferral(options.assetsBinding) : ""}    }

    // write to the cache only if the response is not an error;
    // \`cache_save\` handles the Cache-Control and Vary headers
    pragma = res.headers.get('cache-control') || '';
    return pragma && res.status < 400 ? cache_save(req, res, ctx) : res;
  },
};

${options.effect !== undefined ? effectExports(options.effect) : "export default kit_handler;"}
`.trimStart();
