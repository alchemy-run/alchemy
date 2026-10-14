/**
 * The sandbox's egress route table (DESIGN.md §7): which requests go to which
 * gateway, with which grant. One table covers all of a sandbox's gateways;
 * the most specific match wins, and a request that matches no route goes
 * straight out with no credential.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { canonicalJson } from "./Canonical.ts";
import type { EgressRef, MintedGrant } from "./Kind.ts";

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
export const hasRoute = (routes: ReadonlyArray<{ readonly host: string }>, host: string) =>
  routes.some((route) => sameHost(route.host, host));

/**
 * The route for a request to `host` + `path`: the matching route whose
 * matching pattern has the most literal characters. A route without `paths`
 * covers the whole host and loses to any path match. `undefined` when no
 * route covers the request.
 */
export const mostSpecific = <R extends Pick<Route, "host" | "paths"> = Route>(
  routes: ReadonlyArray<R>,
  host: string,
  path: string,
): R | undefined => {
  const target = pathOf(path);
  let best: R | undefined;
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

//#region building a route table

/** Whether some path matches both patterns (conservative: may over-report). */
const patternsOverlap = (a: string, b: string) => {
  const wild = (pattern: string) => pattern.includes("*");
  if (!wild(a)) return !wild(b) ? pathOf(a) === pathOf(b) : compile(b).regex.test(pathOf(a));
  if (!wild(b)) return compile(a).regex.test(pathOf(b));
  // The literal part before the first wildcard. Ending in `/`, it is whole
  // segments: `/ab/**` and `/a/**` share no path.
  const [pa, pb] = [a.slice(0, a.indexOf("*")), b.slice(0, b.indexOf("*"))];
  return pa.startsWith(pb) || pb.startsWith(pa);
};

/** Whether two routes could both match one request. */
export const routesOverlap = (
  a: Pick<Route, "host" | "paths">,
  b: Pick<Route, "host" | "paths">,
): boolean =>
  sameHost(a.host, b.host) &&
  (a.paths === undefined ||
    b.paths === undefined ||
    a.paths.some((pa) => b.paths!.some((pb) => patternsOverlap(pa, pb))));

/**
 * Two granted egresses claim the same requests: the same host with no path
 * to tell them apart (e.g. two GitHub egresses that both route GraphQL).
 */
export class EgressRouteConflict extends Data.TaggedError("EgressRouteConflict")<{
  readonly message: string;
  readonly host: string;
  readonly egresses: readonly [EgressRef, EgressRef];
}> {}

const describeRef = (ref: EgressRef) =>
  `${ref.gateway}.${ref.egress}${ref.scope === undefined ? "" : ` ${canonicalJson(ref.scope)}`}${ref.subject === undefined ? "" : ` for ${ref.subject}`}`;

/**
 * The sandbox's route table (DESIGN.md §7): every granted egress's routes,
 * pointed at its gateway with that gateway's grant.
 *
 * `minted` holds one minted grant per gateway, from minting that gateway's
 * refs in the order they appear in `granted`; its `routes` are aligned with
 * them. Fails with {@link EgressRouteConflict} when two different egresses
 * claim overlapping requests.
 */
export const routesFor = (
  granted: ReadonlyArray<EgressRef>,
  minted: Readonly<Record<string, MintedGrant>>,
): Effect.Effect<ReadonlyArray<Route>, EgressRouteConflict> =>
  Effect.gen(function* () {
    const table: Array<Route & { readonly ref: EgressRef; readonly key: string }> = [];
    const seen = new Set<string>();
    const positions = new Map<string, number>();
    for (const ref of granted) {
      const position = positions.get(ref.gateway) ?? 0;
      positions.set(ref.gateway, position + 1);
      const key = canonicalJson(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      const grant = minted[ref.gateway];
      if (!grant) continue;
      for (const spec of grant.routes[position] ?? []) {
        const route: Route = {
          host: spec.host,
          ...(spec.paths !== undefined ? { paths: spec.paths } : {}),
          gateway: grant.gateway,
          grant: grant.grant,
        };
        const clash = table.find((other) => other.key !== key && routesOverlap(other, route));
        if (clash) {
          return yield* new EgressRouteConflict({
            message: `${describeRef(clash.ref)} and ${describeRef(ref)} both claim ${route.host}${route.paths ? ` ${route.paths.join(", ")}` : ""}`,
            host: route.host,
            egresses: [clash.ref, ref],
          });
        }
        table.push({ ...route, ref, key });
      }
    }
    return table.map(({ ref: _ref, key: _key, ...route }) => route);
  });

//#endregion
