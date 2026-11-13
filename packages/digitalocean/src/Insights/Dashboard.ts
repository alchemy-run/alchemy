import * as DO from "@distilled.cloud/digitalocean";
import type { Dashboard as ApiDashboard } from "@distilled.cloud/digitalocean";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type DashboardProps = {
  /**
   * The dashboard definition: a document with `kind: "Dashboard"` and a
   * `spec.display.name`. `GET /v2/insights/dashboards/schema` returns its
   * JSON Schema. Updates in place.
   */
  definition: Record<string, unknown>;
};

export type Dashboard = Resource<
  "DigitalOcean.Insights.Dashboard",
  DashboardProps,
  {
    /** Dashboard UUID. */
    dashboardId: string;
    /** Dashboard name, from the definition. */
    name: string | undefined;
  },
  never,
  Providers
>;

export type DashboardAttributes = Dashboard["Attributes"];

/**
 * An Insights dashboard of metric panels. The whole definition updates in
 * place.
 *
 * ### Creating a Dashboard
 * **Example:** A named dashboard
 * ```typescript
 * yield* DigitalOcean.Insights.Dashboard("overview", {
 *   definition: {
 *     kind: "Dashboard",
 *     metadata: { name: "overview" },
 *     spec: { display: { name: "Overview" }, panels: {}, layouts: [] },
 *   },
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Insights
 *
 * @resource
 * @product Insights
 * @category Observability
 */
export const Dashboard = Resource<Dashboard>("DigitalOcean.Insights.Dashboard");

const toAttrs = (dashboard: ApiDashboard): DashboardAttributes => ({
  dashboardId: dashboard.uuid,
  name: dashboard.name,
});

const observe = (uuid: string) =>
  noneIfNotFound(DO.getInsightDashboard({ uuid }).pipe(Effect.map((r) => r.dashboard)));

const canonical = (text: string) => {
  const sort = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sort)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, sort(v)]),
          )
        : value;
  return Effect.try({
    try: () => JSON.stringify(sort(JSON.parse(text))),
    catch: () => text,
  }).pipe(Effect.orElseSucceed(() => text));
};

export const DashboardProvider = () =>
  Provider.succeed(Dashboard, {
    stables: ["dashboardId"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const observed = yield* observe(output.dashboardId);
      return Option.getOrUndefined(Option.map(observed, toAttrs));
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const spec = JSON.stringify(news.definition);
      const observed =
        output === undefined ? Option.none<ApiDashboard>() : yield* observe(output.dashboardId);
      if (Option.isNone(observed)) {
        const { dashboard } = yield* DO.createInsightDashboard({ spec });
        return toAttrs(dashboard);
      }
      if ((yield* canonical(observed.value.spec)) === (yield* canonical(spec))) {
        return toAttrs(observed.value);
      }
      const { dashboard } = yield* DO.updateInsightDashboard({ uuid: observed.value.uuid, spec });
      return toAttrs(dashboard);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteInsightDashboard({ uuid: output.dashboardId }));
    }),
  });
