/**
 * `server.routes` glob matching — the same path-glob dialect Cloudflare's
 * `assets.runWorkerFirst` rules use: `*` matches any run of characters
 * (including `/`), and a leading `!` marks an exclusion. Exclusions take
 * precedence over inclusions, mirroring Cloudflare's rule semantics.
 *
 * Pure and side-effect free — safe to import from plan-time code and tests.
 */

/**
 * The default URL space an effectful Website's `fetch` handler owns when
 * `server.routes` is not configured. Every routes-carrying serve surface
 * (`Serve.make`, `makeWebsiteExports`, `makeWebsiteHandlers`, the
 * framework adapters) falls back to this claim, matching the constructs'
 * own `server.routes` default.
 */
export const DEFAULT_SERVER_ROUTES = ["/api/*"];

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const compiled = new Map<string, RegExp>();

const toRegExp = (glob: string): RegExp => {
  let regexp = compiled.get(glob);
  if (regexp === undefined) {
    regexp = new RegExp(`^${glob.split("*").map(escapeRegExp).join(".*")}$`);
    compiled.set(glob, regexp);
  }
  return regexp;
};

/**
 * Does `pathname` fall inside the URL space described by `routes`?
 *
 * A path matches when it matches at least one inclusion rule and no
 * exclusion (`!`-prefixed) rule.
 */
export const matchRoutes = (
  routes: readonly string[],
  pathname: string,
): boolean => {
  for (const route of routes) {
    if (route.startsWith("!") && toRegExp(route.slice(1)).test(pathname)) {
      return false;
    }
  }
  for (const route of routes) {
    if (!route.startsWith("!") && toRegExp(route).test(pathname)) {
      return true;
    }
  }
  return false;
};
