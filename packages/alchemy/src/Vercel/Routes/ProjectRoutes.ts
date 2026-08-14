import * as projectRoutes from "@distilled.cloud/vercel/project_routes";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";

/** Request parameter a route condition matches against. */
export type RouteConditionType = "host" | "header" | "cookie" | "query";

/** A `has`/`missing` condition on a routing rule. */
export interface RouteCondition {
  /** Request parameter to match on. */
  type: RouteConditionType;
  /** Sub-key for keyed parameters (the header, cookie, or query-param name). */
  key?: string;
  /** Value to compare against. Omit to match on presence alone. */
  value?: string;
}

/** Part of the request/response a transform applies to. */
export type RouteTransformType =
  | "request.headers"
  | "request.query"
  | "response.headers";

/** Operation a transform applies. */
export type RouteTransformOp = "append" | "set" | "delete";

/** A request/response transform applied when the rule matches. */
export interface RouteTransform {
  /** Part of the request/response the transform applies to. */
  type: RouteTransformType;
  /** Operation to apply. */
  op: RouteTransformOp;
  /** Target key selector (e.g. `{ key: "x-header" }`). */
  target?: unknown;
  /** Value argument(s) for `append`/`set`. */
  args?: unknown;
  /** Environment variable names interpolated into `args`. */
  env?: string[];
}

/** The route definition of a rule (from `@vercel/routing-utils`). */
export interface ProjectRouteDefinition {
  /** Source pattern (path-to-regexp, regex, or exact — see `srcSyntax`). */
  src: string;
  /** Destination path or URL. Omit for status-only or transform rules. */
  dest?: string;
  /** Response headers set when the rule matches. */
  headers?: Record<string, string>;
  /**
   * Whether the source pattern is matched case-sensitively.
   * @default false
   */
  caseSensitive?: boolean;
  /** HTTP status (e.g. `308` makes a `dest` rule a redirect). */
  status?: number;
  /** Conditions that must all be present for the rule to match. */
  has?: RouteCondition[];
  /** Conditions that must all be absent for the rule to match. */
  missing?: RouteCondition[];
  /** Request/response transforms applied when the rule matches. */
  transforms?: RouteTransform[];
  /** Respect the origin's `Cache-Control` on rewritten responses. */
  respectOriginCacheControl?: boolean;
}

/** A single routing rule. Rules are evaluated in array order. */
export interface ProjectRouteRule {
  /**
   * Stable client-chosen identifier for the rule (e.g. `"legacy-blog"`).
   * Keep it constant across deploys — it is how a rule is tracked through
   * the document's versions.
   */
  id: string;
  /** Human-readable name of the rule. */
  name: string;
  /** Optional description of what the rule does. */
  description?: string;
  /**
   * Whether the rule is active.
   * @default true
   */
  enabled?: boolean;
  /** The route definition. */
  route: ProjectRouteDefinition;
}

export interface ProjectRoutesProps {
  /**
   * ID of the Vercel project the routing rules apply to. A project has
   * exactly one routing-rules document; changing this property replaces the
   * resource (the old project's document is reset to empty).
   */
  projectId: string;
  /**
   * The full ordered list of routing rules. The document is versioned and
   * replaced wholesale on every change — rules not listed here are removed.
   */
  routes: ProjectRouteRule[];
}

/** Summary of a deployed routing rule. */
export interface ProjectRouteAttribute {
  id: string;
  name: string;
  enabled: boolean;
  /** Computed route type reported by the API (`redirect`, `rewrite`, …). */
  routeType?: string;
}

export type ProjectRoutes = Resource<
  "Vercel.ProjectRoutes",
  ProjectRoutesProps,
  {
    /** ID of the project the document is attached to. */
    projectId: string;
    /** ID of the promoted (production) routes version. */
    versionId: string;
    /** Number of rules in the promoted version. */
    ruleCount: number;
    /** Deployed rules in evaluation order. */
    routes: ProjectRouteAttribute[];
  },
  never,
  Providers
>;

type ProjectRoutesAttributes = ProjectRoutes["Attributes"];

/**
 * Project-level routing rules (redirects, rewrites, transforms) for a Vercel
 * project, managed through Vercel's staged+promote versioning model.
 *
 * The routing rules of a project form a versioned singleton document: edits
 * accumulate in a single staging version, and a promote publishes that
 * version to production. The provider reconciles by comparing the observed
 * production document against the desired rules and, on any delta, staging
 * the full desired document (`overwrite`) and promoting it in one step —
 * so the resource always describes the complete production document.
 *
 * An unpromoted staging draft created out-of-band (e.g. in the dashboard) is
 * replaced the next time the resource reconciles a delta: staging is a
 * single slot, and this resource owns the document.
 *
 * Deleting the resource resets the project's routing rules by staging and
 * promoting an empty document.
 *
 * @resource
 * @section Creating Routing Rules
 * @example Redirect a legacy path
 * ```typescript
 * const routes = yield* Vercel.ProjectRoutes("Routes", {
 *   projectId: project.projectId,
 *   routes: [
 *     {
 *       id: "legacy-blog",
 *       name: "Legacy blog redirect",
 *       route: { src: "/blog/old", dest: "/blog/new", status: 308 },
 *     },
 *   ],
 * });
 * ```
 *
 * @example Rewrite with a capture group
 * ```typescript
 * const routes = yield* Vercel.ProjectRoutes("Routes", {
 *   projectId: project.projectId,
 *   routes: [
 *     {
 *       id: "docs-rewrite",
 *       name: "Serve docs from /documentation",
 *       route: { src: "/docs/(.*)", dest: "/documentation/$1" },
 *     },
 *   ],
 * });
 * ```
 *
 * @section Conditional Rules
 * @example Match only when a header is present
 * ```typescript
 * const routes = yield* Vercel.ProjectRoutes("Routes", {
 *   projectId: project.projectId,
 *   routes: [
 *     {
 *       id: "beta-gate",
 *       name: "Beta cookie gate",
 *       route: {
 *         src: "/beta/(.*)",
 *         dest: "/coming-soon",
 *         has: [{ type: "cookie", key: "beta", value: "off" }],
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @example Disable a rule without deleting it
 * ```typescript
 * const routes = yield* Vercel.ProjectRoutes("Routes", {
 *   projectId: project.projectId,
 *   routes: [
 *     {
 *       id: "maintenance",
 *       name: "Maintenance page",
 *       enabled: false,
 *       route: { src: "/(.*)", dest: "/maintenance", status: 307 },
 *     },
 *   ],
 * });
 * ```
 *
 * @see https://vercel.com/docs/edge-network/routing-rules
 */
export const ProjectRoutes = Resource<ProjectRoutes>("Vercel.ProjectRoutes");

export const ProjectRoutesProvider = () =>
  Provider.succeed(ProjectRoutes, {
    stables: ["projectId"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const oldProjectId = output?.projectId ?? olds?.projectId;
      if (oldProjectId !== undefined && news.projectId !== oldProjectId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const projectId = output?.projectId ?? olds?.projectId;
      if (projectId === undefined) return undefined;
      const { teamId } = yield* VercelEnvironment.current;
      return yield* projectRoutes.getRoutes({ projectId, teamId }).pipe(
        Effect.map((doc) =>
          // `version: null` = no routes document has ever been staged for
          // this project — the resource does not exist yet.
          doc.version == null ? undefined : toAttributes(projectId, doc),
        ),
        // NotFound = the host project itself is gone.
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const { teamId } = yield* VercelEnvironment.current;
      const projectId = news.projectId;
      // Observe — the staging slot shadows `getRoutes`, so only trust the
      // read as production truth when no staging version exists.
      const versions = yield* projectRoutes.getRouteVersions({
        projectId,
        teamId,
      });
      const hasStaging = versions.versions.some((v) => v.isStaging === true);
      if (!hasStaging) {
        const observed = yield* projectRoutes.getRoutes({ projectId, teamId });
        if (
          observed.version != null &&
          matchesDesired(news.routes, observed.routes)
        ) {
          return toAttributes(projectId, observed);
        }
      }
      // Sync — stage the full desired document and promote it. A crash
      // between the two calls leaves a staging version; the next reconcile
      // observes `hasStaging`, restages, and promotes — converging.
      const staged = yield* projectRoutes.stageRoutes({
        projectId,
        teamId,
        overwrite: true,
        routes: news.routes.map(toRequestRoute),
      });
      yield* projectRoutes.updateRouteVersions({
        projectId,
        teamId,
        id: staged.version.id,
        action: "promote",
      });
      const final = yield* projectRoutes.getRoutes({ projectId, teamId });
      return toAttributes(projectId, final, staged.version.id);
    }),
    delete: Effect.fn(function* ({ output }) {
      const { teamId } = yield* VercelEnvironment.current;
      // Reset = stage an empty document and promote it. Idempotent: an
      // already-empty document just gains an empty version; a deleted host
      // project surfaces as NotFound and is not an error.
      yield* projectRoutes
        .stageRoutes({
          projectId: output.projectId,
          teamId,
          overwrite: true,
          routes: [],
        })
        .pipe(
          Effect.flatMap((staged) =>
            projectRoutes.updateRouteVersions({
              projectId: output.projectId,
              teamId,
              id: staged.version.id,
              action: "promote",
            }),
          ),
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }),
  });

// ─────────────────────────────────────────────────────────────────────────────
// Document mapping & comparison helpers
// ─────────────────────────────────────────────────────────────────────────────

const toRequestRoute = (
  rule: ProjectRouteRule,
): projectRoutes.StageRoutesRequestRoutesItem => ({
  id: rule.id,
  name: rule.name,
  description: rule.description,
  enabled: rule.enabled,
  route: {
    src: rule.route.src,
    dest: rule.route.dest,
    headers: rule.route.headers,
    caseSensitive: rule.route.caseSensitive,
    status: rule.route.status,
    has: rule.route.has,
    missing: rule.route.missing,
    transforms: rule.route.transforms,
    respectOriginCacheControl: rule.route.respectOriginCacheControl,
  },
});

const toAttributes = (
  projectId: string,
  doc: projectRoutes.GetRoutesResponse,
  fallbackVersionId?: string,
): ProjectRoutesAttributes => ({
  projectId,
  versionId: doc.version?.id ?? fallbackVersionId ?? "",
  ruleCount: doc.routes.length,
  routes: doc.routes.map((item) => ({
    id: item.id,
    name: item.name,
    enabled: item.enabled ?? true,
    ...(item.routeType !== undefined ? { routeType: item.routeType } : {}),
  })),
});

/**
 * Deterministic stringify: object keys sorted, `undefined`/`null` members
 * dropped, arrays kept in order — so a server-echoed document compares equal
 * to our desired literal.
 */
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
};

const emptyToUndefined = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

interface CanonicalRoute {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  route: {
    src: string;
    dest?: string;
    headers?: unknown;
    caseSensitive?: boolean;
    status?: number;
    has?: unknown;
    missing?: unknown;
    transforms?: unknown;
    respectOriginCacheControl?: boolean;
  };
}

const canonicalFromProps = (rule: ProjectRouteRule): CanonicalRoute => ({
  id: rule.id,
  name: rule.name,
  description: emptyToUndefined(rule.description),
  enabled: rule.enabled ?? true,
  route: {
    src: rule.route.src,
    dest: rule.route.dest,
    headers: rule.route.headers,
    caseSensitive: rule.route.caseSensitive === true ? true : undefined,
    status: rule.route.status,
    has: rule.route.has,
    missing: rule.route.missing,
    transforms: rule.route.transforms,
    respectOriginCacheControl:
      rule.route.respectOriginCacheControl === true ? true : undefined,
  },
});

const canonicalFromObserved = (
  item: projectRoutes.GetRoutesResponseRoutesItem,
): CanonicalRoute => ({
  id: item.id,
  name: item.name,
  description: emptyToUndefined(item.description),
  enabled: item.enabled ?? true,
  route: {
    // The API compiles the user's pattern; `rawSrc`/`rawDest` echo the
    // original input and are the comparison baseline when present.
    src: item.rawSrc ?? item.route.src,
    dest: item.rawDest ?? item.route.dest,
    headers: item.route.headers,
    caseSensitive: item.route.caseSensitive === true ? true : undefined,
    status: item.route.status,
    has: item.route.has,
    missing: item.route.missing,
    transforms: item.route.transforms,
    respectOriginCacheControl:
      item.route.respectOriginCacheControl === true ? true : undefined,
  },
});

const matchesDesired = (
  desired: ProjectRouteRule[],
  observed: ReadonlyArray<projectRoutes.GetRoutesResponseRoutesItem>,
): boolean =>
  stableStringify(desired.map(canonicalFromProps)) ===
  stableStringify(observed.map(canonicalFromObserved));
