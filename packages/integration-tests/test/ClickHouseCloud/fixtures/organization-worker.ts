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
    const postgresMetrics =
      yield* ClickHouseCloud.Prometheus.GetOrganizationPostgresPrometheusMetrics(Org);
    const getUsageCost = yield* ClickHouseCloud.Billing.GetUsageCost(Org);
    const getCreditBalances = yield* ClickHouseCloud.Billing.GetCreditBalances(Org);
    const listNotifications = yield* ClickHouseCloud.Notifications.ListNotifications(Org);
    const listNotificationTypes = yield* ClickHouseCloud.Notifications.ListNotificationTypes(Org);

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

        if (url.pathname === "/postgres-metrics") {
          const text = yield* postgresMetrics();
          return yield* HttpServerResponse.json({ isText: typeof text === "string" });
        }

        if (url.pathname === "/billing") {
          const today = new Date().toISOString().slice(0, 10);
          const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
          const usage = yield* getUsageCost({ fromDate: weekAgo, toDate: today });
          const credits = yield* getCreditBalances();
          return yield* HttpServerResponse.json({
            grandTotal: usage.grandTotalCHC ?? null,
            costEntities: (usage.costs ?? []).map((c) => c.entityType ?? null),
            remaining: credits.totalRemainingCredits ?? null,
            balances: (credits.balances ?? []).length,
          });
        }

        if (url.pathname === "/notifications") {
          const types = yield* listNotificationTypes();
          const feed = yield* listNotifications({ resourceType: "organization" });
          return yield* HttpServerResponse.json({
            typeNames: types.map((t) => t.name),
            feedResourceTypes: [...new Set(feed.map((n) => n.resourceType))],
          });
        }

        // Not 404: a fresh workers.dev URL answers 404 until it propagates.
        return HttpServerResponse.text("no such route", { status: 400 });
      }).pipe(
        // Answer failures and defects with the cause so a failing test shows it.
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: Cause.pretty(cause) }, { status: 500 }),
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
        ClickHouseCloud.Prometheus.GetOrganizationPostgresPrometheusMetricsHttp,
        ClickHouseCloud.Billing.GetUsageCostHttp,
        ClickHouseCloud.Billing.GetCreditBalancesHttp,
        ClickHouseCloud.Notifications.ListNotificationsHttp,
        ClickHouseCloud.Notifications.ListNotificationTypesHttp,
      ),
    ),
  ),
) {}
