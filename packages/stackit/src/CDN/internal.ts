import * as cdn from "@distilled.cloud/stackit/cdn";
import * as Effect from "effect/Effect";

/** Budget of the official SDK's distribution and custom domain handlers. */
export const CDN_TIMEOUT = "10 minutes";

/** CDN changes take a while to roll out, so polls start slower than the shared default. */
export const CDN_POLL = { interval: "2 seconds", maxInterval: "15 seconds" } as const;

/**
 * Polls (about 40 seconds at {@link CDN_POLL}) during which a status read right
 * after a write may still describe the state before it.
 */
export const STALE_POLLS = 6;

/** Far beyond any project quota; keeps a server-side paging bug from looping forever. */
const MAX_LIST_PAGES = 100;

/** A problem STACKIT reports on a distribution or custom domain. */
export interface CdnError {
  /** Machine-readable key, e.g. `CUSTOM_DOMAIN_CNAME_MISSING`. */
  key: string;
  /** English description. */
  message: string;
}

export const toCdnErrors = (errors: ReadonlyArray<cdn.StatusError> | undefined): CdnError[] =>
  (errors ?? []).map((error) => ({ key: error.key, message: error.en }));

export const errorSummary = (
  errors: ReadonlyArray<cdn.StatusError> | undefined,
  status: string,
): string => {
  const reported = toCdnErrors(errors).map((error) => `${error.key}: ${error.message}`);
  return reported.length > 0 ? reported.join("; ") : status;
};

/** `GetDistribution`; `undefined` when the distribution is gone. */
export const getDistributionOrUndefined = (projectId: string, distributionId: string) =>
  cdn.getDistribution({ projectId, distributionId }).pipe(
    Effect.map(({ distribution }) => distribution),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/** Every distribution of a project, across all pages. */
export const listAllDistributions = (projectId: string) =>
  Effect.gen(function* () {
    const all: cdn.Distribution[] = [];
    let pageIdentifier: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const response = yield* cdn.listDistributions({
        projectId,
        pageSize: 100,
        ...(pageIdentifier !== undefined ? { pageIdentifier } : {}),
      });
      all.push(...response.distributions);
      pageIdentifier = response.nextPageIdentifier === "" ? undefined : response.nextPageIdentifier;
      if (pageIdentifier === undefined) break;
    }
    return all;
  });

/** `GetCustomDomain`; `undefined` when the domain isn't on the distribution. */
export const getCustomDomainOrUndefined = (
  projectId: string,
  distributionId: string,
  domain: string,
) =>
  cdn
    .getCustomDomain({ projectId, distributionId, domain })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
