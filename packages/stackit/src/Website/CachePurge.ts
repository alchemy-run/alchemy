import * as cdn from "@distilled.cloud/stackit/cdn";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";

/** Past this many changed paths, one full purge replaces one call per path. */
const MAX_GRANULAR_PURGES = 100;

export interface CachePurgeProps {
  /** Id of the distribution, e.g. `distribution.distributionId`. */
  distributionId: string;
  /** Project of the distribution. */
  projectId: string;
  /**
   * Hash of what was deployed. With `all: true`, a new value purges everything.
   */
  version: string;
  /**
   * The unhashed files by URL path, with a hash of each one's content. A path whose
   * hash changed or that disappeared is purged.
   */
  files: Record<string, string>;
  /**
   * Purge the whole distribution when `version` changes, instead of the changed
   * paths. STACKIT's docs warn this can stampede the origin.
   * @default false
   */
  all?: boolean;
}

export type CachePurge = Resource<
  "Stackit.Website.CachePurge",
  CachePurgeProps,
  {
    /** Id of the distribution. */
    distributionId: string;
    /** `version` at the last deploy. */
    version: string;
    /** `files` at the last deploy. */
    files: Record<string, string>;
    /** The paths the last deploy purged. `["*"]` is a full purge. */
    purgedPaths: string[];
  },
  never,
  Providers
>;

/**
 * Purge what a deploy changed from a `Stackit.CDN.Distribution`. Each deploy calls
 * the API once per changed unhashed path, or once for the whole cache past 100 of
 * them. A file with a content hash gets a new URL, so it is never purged.
 *
 * A new distribution holds nothing, so its first deploy purges nothing. STACKIT
 * treats `/a` and `/a.txt` as different paths and has no wildcard, so each URL a
 * file is served at is its own entry in `files`.
 *
 * ### Purging
 * **Example:** Purge what an upload changed
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * yield* Stackit.Website.CachePurge("Purge", {
 *   distributionId: cdn.distributionId,
 *   projectId: cdn.projectId,
 *   version: files.version,
 *   files: files.purgeable,
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const CachePurge = Resource<CachePurge>("Stackit.Website.CachePurge");

const changedPaths = (previous: Record<string, string>, current: Record<string, string>) => {
  const removed = Object.keys(previous).filter((path) => !(path in current));
  const changed = Object.keys(current).filter((path) => {
    const before = previous[path];
    return before !== undefined && before !== current[path];
  });
  return [...removed, ...changed].sort();
};

export const CachePurgeProvider = () =>
  Provider.succeed(CachePurge, {
    // Nothing to enumerate: a purge leaves no resource behind.
    list: () => Effect.succeed([]),

    read: ({ output }) => Effect.succeed(output),

    reconcile: Effect.fn(function* ({ news, output, session }) {
      const { distributionId, projectId } = news;
      // What this distribution was last given. Only that can be in its cache.
      const previous = output?.distributionId === distributionId ? output : undefined;
      const paths =
        previous === undefined
          ? []
          : news.all === true
            ? previous.version === news.version
              ? []
              : ["*"]
            : changedPaths(previous.files, news.files);
      if (paths.includes("*") || paths.length > MAX_GRANULAR_PURGES) {
        yield* cdn.purgeCache({ projectId, distributionId });
      } else {
        yield* Effect.forEach(
          paths,
          (path) => cdn.purgeCache({ projectId, distributionId, path }),
          { concurrency: 4, discard: true },
        );
      }
      if (paths.length > 0) yield* session.note(`Purged ${paths.length} paths from the CDN`);
      return {
        distributionId,
        version: news.version,
        files: news.files,
        purgedPaths: paths.length > MAX_GRANULAR_PURGES ? ["*"] : paths,
      };
    }),

    // Nothing to undo: entries it purged came back on their own.
    delete: () => Effect.void,
  });
