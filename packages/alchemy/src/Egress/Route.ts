/**
 * The sandbox's egress route table (DESIGN.md §7): which requests go to which
 * gateway, with which grant. One table covers all of a sandbox's gateways;
 * the most specific match wins, and a request that matches no route goes
 * straight out with no credential.
 */
import * as Schema from "effect/Schema";

export interface Route {
  /** The host the route covers, e.g. `api.github.com`. */
  readonly host: string;
  /**
   * Path patterns within the host. `*` matches within one segment, `**`
   * across segments; a trailing `/**` also matches the bare prefix
   * (`/a/b/**` covers `/a/b`). Absent: the whole host.
   */
  readonly paths?: ReadonlyArray<string>;
  /** The gateway that runs this route's egress. */
  readonly gateway: { readonly id: string; readonly url: string };
  /** That gateway's grant, encoded. Sent as `Authorization: Macaroon <grant>`. */
  readonly grant: string;
}

/** The wire shape of a route table (`ALCHEMY_EGRESS_ROUTES`, `PUT /routes`). */
export const Routes: Schema.Codec<ReadonlyArray<Route>> = Schema.Array(
  Schema.Struct({
    host: Schema.String,
    paths: Schema.optional(Schema.Array(Schema.String)),
    gateway: Schema.Struct({ id: Schema.String, url: Schema.String }),
    grant: Schema.String,
  }),
);

interface CompiledPattern {
  readonly regex: RegExp;
  /** Literal characters in the pattern: more literal is more specific. */
  readonly specificity: number;
}

const compiled = new Map<string, CompiledPattern>();

const compile = (pattern: string): CompiledPattern => {
  const cached = compiled.get(pattern);
  if (cached) return cached;
  let source = "";
  let specificity = 0;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (pattern.startsWith("/**", i) && i + 3 === pattern.length) {
      source += "(?:/.*)?";
      break;
    }
    if (pattern.startsWith("**", i)) {
      source += ".*";
      i++;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      specificity++;
    }
  }
  const result = { regex: new RegExp(`^${source}$`), specificity };
  compiled.set(pattern, result);
  return result;
};

/** The path without its query string or fragment. */
const pathOf = (path: string) => {
  const end = path.search(/[?#]/);
  const bare = end === -1 ? path : path.slice(0, end);
  return bare.startsWith("/") ? bare : `/${bare}`;
};

const sameHost = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Whether any route covers `host` (so its traffic must be decrypted to route by path). */
export const hasRoute = (routes: ReadonlyArray<Route>, host: string) =>
  routes.some((route) => sameHost(route.host, host));

/**
 * The route for a request to `host` + `path`: the matching route whose
 * matching pattern has the most literal characters. A route without `paths`
 * covers the whole host and loses to any path match. `undefined` when no
 * route covers the request.
 */
export const mostSpecific = (
  routes: ReadonlyArray<Route>,
  host: string,
  path: string,
): Route | undefined => {
  const target = pathOf(path);
  let best: Route | undefined;
  let bestScore = -1;
  for (const route of routes) {
    if (!sameHost(route.host, host)) continue;
    if (route.paths === undefined) {
      if (bestScore < 0) {
        best = route;
        bestScore = 0;
      }
      continue;
    }
    for (const pattern of route.paths) {
      const { regex, specificity } = compile(pattern);
      // +1 so any path match beats a whole-host route.
      if (specificity + 1 > bestScore && regex.test(target)) {
        best = route;
        bestScore = specificity + 1;
      }
    }
  }
  return best;
};
