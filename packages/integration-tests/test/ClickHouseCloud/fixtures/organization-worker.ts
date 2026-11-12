import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Org } from "./resources.ts";

export default class ClickHouseOrgWorker extends Cloudflare.Worker<ClickHouseOrgWorker>()(
  "ClickHouseOrgWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const listActivities = yield* ClickHouseCloud.Organization.ListActivities(Org);
    const getActivity = yield* ClickHouseCloud.Organization.GetActivity(Org);
    const listQuotas = yield* ClickHouseCloud.Organization.ListOrganizationQuotas(Org);
    const getQuota = yield* ClickHouseCloud.Organization.GetOrganizationQuota(Org);
    const discover = yield* ClickHouseCloud.Prometheus.GetOrganizationPrometheusDiscovery(Org);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");

        if (url.pathname === "/activities") {
          const since = new Date(Date.now() - 3_600_000).toISOString();
          const activities = yield* listActivities({ fromDate: since });
          const first = activities[0];
          const one = first?.id === undefined ? undefined : yield* getActivity(first.id);
          return yield* HttpServerResponse.json({
            count: activities.length,
            types: activities.map((a) => a.type),
            firstId: first?.id ?? null,
            fetchedId: one?.id ?? null,
          });
        }

        if (url.pathname === "/quotas") {
          const quotas = yield* listQuotas();
          const keys = yield* getQuota("api-keys-per-organization");
          return yield* HttpServerResponse.json({
            codes: quotas.map((q) => q.quotaCode),
            keys: { code: keys.quotaCode, value: keys.value, usage: keys.usage ?? null },
          });
        }

        if (url.pathname === "/discovery") {
          const groups = yield* discover({ filteredMetrics: true });
          return yield* HttpServerResponse.json({
            orgIds: groups.map((g) => g.labels?.clickhouse_org_id ?? null),
          });
        }

        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(
        // Answer failures and defects with the cause so a failing test shows it.
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ClickHouseCloud.Organization.ListActivitiesHttp,
        ClickHouseCloud.Organization.GetActivityHttp,
        ClickHouseCloud.Organization.ListOrganizationQuotasHttp,
        ClickHouseCloud.Organization.GetOrganizationQuotaHttp,
        ClickHouseCloud.Prometheus.GetOrganizationPrometheusDiscoveryHttp,
      ),
    ),
  ),
) {}
