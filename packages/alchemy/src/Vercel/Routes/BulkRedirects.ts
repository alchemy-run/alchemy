import * as bulkRedirects from "@distilled.cloud/vercel/bulk_redirects";
import * as projects from "@distilled.cloud/vercel/projects";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";

/** A single redirect entry. */
export interface BulkRedirect {
  /** Source path to match (e.g. `/old-path`). */
  source: string;
  /** Destination path or URL. */
  destination: string;
  /**
   * HTTP redirect status. Takes precedence over `permanent`.
   * @default 307
   */
  statusCode?: number;
  /**
   * Shorthand for the status: `true` = 308, `false` = 307. Ignored when
   * `statusCode` is set.
   * @default false
   */
  permanent?: boolean;
  /**
   * Whether the source is matched case-sensitively.
   * @default false
   */
  caseSensitive?: boolean;
  /** Whether query parameters participate in matching. */
  query?: boolean;
  /** Whether incoming query parameters are preserved on the redirect. */
  preserveQueryParams?: boolean;
}

export interface BulkRedirectsProps {
  /**
   * ID of the Vercel project the redirects apply to. A project has exactly
   * one bulk-redirects document; changing this property replaces the
   * resource (the old project's document is reset to empty).
   */
  projectId: string;
  /**
   * The full list of redirects. The document is versioned and replaced
   * wholesale on every change — redirects not listed here are removed.
   */
  redirects: BulkRedirect[];
  /**
   * Optional label for versions written by this resource. When omitted,
   * Vercel names versions with an ISO timestamp.
   */
  name?: string;
}

export type BulkRedirects = Resource<
  "Vercel.BulkRedirects",
  BulkRedirectsProps,
  {
    /** ID of the project the document is attached to. */
    projectId: string;
    /** ID of the promoted (production) redirects version. */
    versionId: string;
    /** Content key of the promoted version (same content ⇒ same key). */
    versionKey: string;
    /** Label of the promoted version. */
    versionName: string | undefined;
    /** Number of redirects in the promoted version. */
    redirectCount: number;
  },
  never,
  Providers
>;

type BulkRedirectsAttributes = BulkRedirects["Attributes"];

/**
 * Project-level bulk redirects for a Vercel project, managed through
 * Vercel's staged+promote versioning model.
 *
 * The bulk redirects of a project form a versioned singleton document:
 * edits accumulate in a single staging version, and a promote publishes
 * that version to production. The provider reconciles by comparing the
 * observed production redirects against the desired list and, on any delta,
 * staging the full desired document (`overwrite`) and promoting it in one
 * step — so the resource always describes the complete production document.
 *
 * An unpromoted staging draft created out-of-band (e.g. in the dashboard)
 * is replaced the next time the resource reconciles a delta: staging is a
 * single slot, and this resource owns the document.
 *
 * Deleting the resource resets the project's redirects by staging and
 * promoting an empty document.
 *
 * @resource
 * @section Creating Bulk Redirects
 * @example Redirect legacy paths
 * ```typescript
 * const redirects = yield* Vercel.BulkRedirects("Redirects", {
 *   projectId: project.projectId,
 *   redirects: [
 *     { source: "/old-home", destination: "/" },
 *     { source: "/old-blog", destination: "/blog", statusCode: 308 },
 *   ],
 * });
 * ```
 *
 * @example Temporary (307) redirects
 * ```typescript
 * const redirects = yield* Vercel.BulkRedirects("Redirects", {
 *   projectId: project.projectId,
 *   redirects: [
 *     { source: "/campaign", destination: "/spring-sale", permanent: false },
 *   ],
 * });
 * ```
 *
 * @section Versioning
 * @example Label the promoted version
 * ```typescript
 * const redirects = yield* Vercel.BulkRedirects("Redirects", {
 *   projectId: project.projectId,
 *   name: "migration-2026-08",
 *   redirects: [{ source: "/a", destination: "/b" }],
 * });
 * ```
 *
 * @see https://vercel.com/docs/edge-network/redirects
 */
export const BulkRedirects = Resource<BulkRedirects>("Vercel.BulkRedirects");

export const BulkRedirectsProvider = () =>
  Provider.succeed(BulkRedirects, {
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
      return yield* bulkRedirects
        .getRedirects({ projectId, teamId, per_page: 100 })
        .pipe(
          Effect.map((doc) =>
            // `version: null` = no redirects have ever been promoted for
            // this project — the resource does not exist yet.
            doc.version == null
              ? undefined
              : toAttributes(projectId, doc.version, doc.redirects.length),
          ),
          // NotFound = the host project itself is gone.
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const env = yield* VercelEnvironment.current;
      const projectId = news.projectId;
      // The stage API requires an explicit owner `teamId` in the request
      // body (live-verified: omitting it fails 400 `validation_error` even
      // when the token rides a default team) — derive it from the host
      // project when the profile carries no teamId.
      const teamId =
        env.teamId ??
        (yield* projects.getProject({ idOrName: projectId })).accountId;
      // Observe — `getRedirects` (without versionId) always reflects the
      // promoted production document; staging drafts do not shadow it.
      const observed = yield* listAllRedirects(projectId, teamId);
      const versions = yield* bulkRedirects.getVersions({ projectId, teamId });
      const live = versions.versions.find((v) => v.isLive === true);
      if (live !== undefined && matchesDesired(news.redirects, observed)) {
        return toAttributes(projectId, live, observed.length);
      }
      // Sync — stage the full desired document and promote it. A crash
      // between the two calls leaves a staging draft; the next reconcile
      // still observes production, restages, and promotes — converging.
      const staged = yield* bulkRedirects.stageRedirects({
        projectId,
        teamId,
        overwrite: true,
        name: news.name,
        redirects: news.redirects.map(toRequestRedirect),
      });
      const promoted = yield* bulkRedirects.updateVersion({
        projectId,
        teamId,
        id: staged.version.id,
        action: "promote",
      });
      return toAttributes(
        projectId,
        promoted.version,
        promoted.version.redirectCount ?? news.redirects.length,
      );
    }),
    delete: Effect.fn(function* ({ output }) {
      const env = yield* VercelEnvironment.current;
      // Reset = stage an empty document and promote it. Idempotent: an
      // already-empty document just gains an empty version; a deleted host
      // project surfaces as NotFound (from getProject or the stage itself)
      // and is not an error.
      yield* Effect.gen(function* () {
        const teamId =
          env.teamId ??
          (yield* projects.getProject({ idOrName: output.projectId }))
            .accountId;
        const staged = yield* bulkRedirects.stageRedirects({
          projectId: output.projectId,
          teamId,
          overwrite: true,
          redirects: [],
        });
        yield* bulkRedirects.updateVersion({
          projectId: output.projectId,
          teamId,
          id: staged.version.id,
          action: "promote",
        });
      }).pipe(
        Effect.asVoid,
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });

// ─────────────────────────────────────────────────────────────────────────────
// Document mapping & comparison helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Page through the promoted production redirects (bounded at 25 pages). */
const listAllRedirects = Effect.fn(function* (
  projectId: string,
  teamId: string,
) {
  const first = yield* bulkRedirects.getRedirects({
    projectId,
    teamId,
    per_page: 100,
  });
  const all = [...first.redirects];
  const numPages = first.pagination?.numPages ?? 1;
  for (let page = 2; page <= Math.min(numPages, 25); page++) {
    const next = yield* bulkRedirects.getRedirects({
      projectId,
      teamId,
      per_page: 100,
      page,
    });
    all.push(...next.redirects);
  }
  return all;
});

const toRequestRedirect = (
  redirect: BulkRedirect,
): bulkRedirects.StageRedirectsRequestRedirectsItem => ({
  source: redirect.source,
  destination: redirect.destination,
  statusCode: redirect.statusCode,
  permanent: redirect.permanent,
  caseSensitive: redirect.caseSensitive,
  query: redirect.query,
  preserveQueryParams: redirect.preserveQueryParams,
});

const toAttributes = (
  projectId: string,
  version: bulkRedirects.DeleteRedirectsResponseBodyCase0Version,
  redirectCount: number,
): BulkRedirectsAttributes => ({
  projectId,
  versionId: version.id,
  versionKey: version.key,
  versionName: version.name,
  redirectCount,
});

interface CanonicalRedirect {
  source: string;
  destination: string;
  statusCode: number;
  caseSensitive?: boolean;
  query?: boolean;
  preserveQueryParams?: boolean;
}

/**
 * Materialized status: explicit `statusCode` wins, else `permanent`
 * (platform default is temporary — 307, live-verified).
 */
const desiredStatus = (redirect: BulkRedirect): number =>
  redirect.statusCode ?? (redirect.permanent === true ? 308 : 307);

const canonicalFromProps = (redirect: BulkRedirect): CanonicalRedirect => ({
  source: redirect.source,
  destination: redirect.destination,
  statusCode: desiredStatus(redirect),
  // Only deviations from the platform defaults participate in the diff —
  // the API omits default-valued flags when echoing rows back.
  caseSensitive: redirect.caseSensitive === true ? true : undefined,
  query: redirect.query === false ? false : undefined,
  preserveQueryParams: redirect.preserveQueryParams === true ? true : undefined,
});

const canonicalFromObserved = (
  item: bulkRedirects.GetRedirectsResponseRedirectsItem,
): CanonicalRedirect => ({
  source: item.source,
  destination: item.destination,
  statusCode: item.statusCode ?? (item.permanent === true ? 308 : 307),
  caseSensitive: item.caseSensitive === true ? true : undefined,
  query: item.query === false ? false : undefined,
  preserveQueryParams: item.preserveQueryParams === true ? true : undefined,
});

/**
 * Deterministic stringify: object keys sorted, `undefined`/`null` members
 * dropped, arrays kept in order.
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

const matchesDesired = (
  desired: BulkRedirect[],
  observed: ReadonlyArray<bulkRedirects.GetRedirectsResponseRedirectsItem>,
): boolean => {
  if (desired.length !== observed.length) return false;
  // Redirect order is not semantic (sources are exact paths) and the API
  // may return rows sorted — compare as source-keyed sets.
  const bySource = (a: CanonicalRedirect, b: CanonicalRedirect) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
  return (
    stableStringify([...desired.map(canonicalFromProps)].sort(bySource)) ===
    stableStringify([...observed.map(canonicalFromObserved)].sort(bySource))
  );
};
