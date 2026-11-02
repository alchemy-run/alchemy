import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { CERT_A_PEM, FIXTURE_DOMAIN, KEY_A_PEM } from "./certs.ts";

export const Cdn = Stackit.CDN.Distribution("CdnBindingsDistribution", {
  backend: { type: "http", originUrl: "https://www.stackit.de" },
});

export const Domain = Cdn.pipe(
  Effect.flatMap((distribution) =>
    Stackit.CDN.CustomDomain("CdnBindingsDomain", {
      distributionId: distribution.distributionId,
      domain: FIXTURE_DOMAIN,
      certificate: {
        type: "custom",
        certificate: CERT_A_PEM,
        privateKey: Redacted.make(KEY_A_PEM),
        skipDnsCheck: true,
      },
    }),
  ),
);

/**
 * A Cloudflare Worker with every CDN binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class CdnBindingsWorker extends Cloudflare.Worker<CdnBindingsWorker>()(
  "StackitCdnBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const distribution = yield* Cdn;
    const domain = yield* Domain;
    const getDistribution = yield* Stackit.CDN.GetDistribution(distribution);
    const listDistributions = yield* Stackit.CDN.ListDistributions(distribution);
    const getCustomDomain = yield* Stackit.CDN.GetCustomDomain(domain);
    const purgeCache = yield* Stackit.CDN.PurgeCache(distribution);
    const getCacheInfo = yield* Stackit.CDN.GetCacheInfo(distribution);
    const findCachePaths = yield* Stackit.CDN.FindCachePaths(distribution);
    const getLogs = yield* Stackit.CDN.GetLogs(distribution);
    const getLogsSearchFilters = yield* Stackit.CDN.GetLogsSearchFilters(distribution);
    const getStatistics = yield* Stackit.CDN.GetStatistics(distribution);
    const listWafCollections = yield* Stackit.CDN.ListWafCollections(distribution);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        switch (url.pathname) {
          case "/get-distribution":
            return yield* respond(getDistribution());
          case "/list-distributions":
            return yield* respond(listDistributions({ pageSize: 100 }));
          case "/get-custom-domain":
            return yield* respond(getCustomDomain());
          case "/purge-cache":
            return yield* respond(purgeCache(param("path") ? { path: param("path") } : {}));
          case "/get-cache-info":
            return yield* respond(getCacheInfo({ purgePath: param("path") }));
          case "/find-cache-paths":
            return yield* respond(findCachePaths({ path: param("path") }));
          case "/get-logs":
            return yield* respond(getLogs({ pageSize: 10 }));
          case "/get-logs-search-filters":
            return yield* respond(getLogsSearchFilters());
          case "/get-statistics":
            return yield* respond(getStatistics({ from: param("from"), interval: "daily" }));
          case "/list-waf-collections":
            return yield* respond(listWafCollections());
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.CDN.GetDistributionHttp,
        Stackit.CDN.ListDistributionsHttp,
        Stackit.CDN.GetCustomDomainHttp,
        Stackit.CDN.PurgeCacheHttp,
        Stackit.CDN.GetCacheInfoHttp,
        Stackit.CDN.FindCachePathsHttp,
        Stackit.CDN.GetLogsHttp,
        Stackit.CDN.GetLogsSearchFiltersHttp,
        Stackit.CDN.GetStatisticsHttp,
        Stackit.CDN.ListWafCollectionsHttp,
      ),
    ),
  ),
) {}
