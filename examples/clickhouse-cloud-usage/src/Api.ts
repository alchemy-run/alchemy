// src/Api.ts
import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/** The organization the deploy credentials belong to; deploying it changes nothing. */
export const Org = ClickHouseCloud.Organization.Organization("Org", {});

const day = (offset: number) =>
  new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

/**
 * A spend report for the organization:
 *
 * - `GET /usage?days=7`: what each service and ClickPipe cost, per day.
 * - `GET /credits`: the credits left.
 * - `GET /notifications`: billing and quota notifications of the last week.
 *
 * Each binding gives the Worker its own API key with a view-only role.
 */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const getUsageCost = yield* ClickHouseCloud.Billing.GetUsageCost(Org);
    const getCreditBalances = yield* ClickHouseCloud.Billing.GetCreditBalances(Org);
    const listNotifications = yield* ClickHouseCloud.Notifications.ListNotifications(Org);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");

        if (url.pathname === "/usage") {
          const days = Math.min(Number(url.searchParams.get("days") ?? "7"), 30);
          const usage = yield* getUsageCost({ fromDate: day(days), toDate: day(0) });
          return yield* HttpServerResponse.json({
            total: usage.grandTotalCHC ?? 0,
            days: (usage.costs ?? []).map((c) => ({
              date: c.date,
              entity: c.entityName,
              type: c.entityType,
              credits: c.totalCHC,
            })),
          });
        }

        if (url.pathname === "/credits") {
          const credits = yield* getCreditBalances();
          return yield* HttpServerResponse.json({ remaining: credits.totalRemainingCredits ?? 0 });
        }

        if (url.pathname === "/notifications") {
          const feed = yield* listNotifications({
            resourceType: "organization",
            fromDate: new Date(Date.now() - 7 * 86_400_000).toISOString(),
          });
          return yield* HttpServerResponse.json(
            feed.map((n) => ({ type: n.type, severity: n.severity, title: n.title })),
          );
        }

        return HttpServerResponse.text("Not found", { status: 404 });
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: String(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ClickHouseCloud.Billing.GetUsageCostHttp,
        ClickHouseCloud.Billing.GetCreditBalancesHttp,
        ClickHouseCloud.Notifications.ListNotificationsHttp,
      ),
    ),
  ),
) {}
