import * as Axiom from "@distilled.cloud/axiom";
import { Unowned, Unresolved } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "./Providers.ts";

/** Dashboard input. */
export type DashboardProps = Axiom.CreateDashboardRequest;

export type Dashboard = Resource<
  "Axiom.Dashboard",
  DashboardProps,
  {
    /** Stable Axiom dashboard `uid` (used as the path identifier). */
    uid: string;
    id: string;
    /** Axiom omits the audit fields on some dashboards. */
    createdAt: string | undefined;
    createdBy: string | undefined;
    updatedAt: string | undefined;
    updatedBy: string | undefined;
    /** The full dashboard document as returned by Axiom. */
    dashboard: Axiom.DashboardWriteResponse["dashboard"]["dashboard"];
  },
  never,
  Providers,
  DashboardLookup
>;

/**
 * Props for {@link Dashboard.lookup}: find a dashboard this stack
 * doesn't manage by its id.
 */
export interface DashboardLookup {
  /** Axiom dashboard id. */
  uid: string;
}

/**
 * An Axiom dashboard — a named, layout-driven collection of charts. Each
 * dashboard takes a full document (`charts` + `layout` array of grid cells +
 * `timeWindow` + `refreshTime`) at version `schemaVersion: 2`.
 *
 * Charts are typed via {@link Chart} (a discriminated union over the
 * Axiom-validated chart kinds — `TimeSeries`, `Table`, `Pie`, `Statistic`,
 * `Heatmap`, `LogStream`, `Note`). The `id` on each chart is a free-form
 * string the author picks; layout cells join via `LayoutCell.i`.
 *
 * The path identifier is `uid` (auto-assigned by Axiom). `id` is also
 * exposed as an output but the API uses `uid` everywhere.
 *
 * Notes from probing `POST /v2/dashboards`:
 *
 * - Relative time windows must use the `qr-now-{duration}` form (e.g.
 *   `"qr-now-7d"` / `"qr-now"`); plain `"now-7d"` is rejected.
 * - When authenticating with an API token, `dashboard.owner` must be `""`
 *   (Axiom rewrites this to the org-shared `X-AXIOM-EVERYONE`); per-user
 *   "private" dashboards aren't allowed for tokens.
 * - The chart payload is strict: only `id`, `name`, `type`, `query`. Extra
 *   keys (e.g. `dataset`, `description`) trigger
 *   `Unrecognized keys: "<name>"`.
 * @see https://axiom.co/docs/query-data/dashboards
 *
 * ### Creating a Dashboard
 * **Example:** Minimal empty dashboard
 * ```typescript
 * yield* Axiom.Dashboard("ops", {
 *   dashboard: {
 *     name: "Ops Overview",
 *     owner: "",                 // org-shared (required for API tokens)
 *     description: "Top-level service health",
 *     charts: [],
 *     layout: [],
 *     refreshTime: 60,           // seconds: 15 | 60 | 300
 *     schemaVersion: 2,
 *     timeWindowStart: "qr-now-1h",
 *     timeWindowEnd: "qr-now",
 *   },
 * });
 * ```
 *
 * **Example:** One-chart dashboard
 * ```typescript
 * import type { Chart, LayoutCell } from "@alchemy.run/axiom";
 *
 * const errors: Chart = {
 *   id: "errors-5m",
 *   name: "5xx errors / 5m",
 *   type: "TimeSeries",
 *   query: {
 *     apl: `['my-app-traces']
 *       | where status >= 500
 *       | summarize count() by bin_auto(_time)`,
 *   },
 * };
 *
 * yield* Axiom.Dashboard("errors", {
 *   dashboard: {
 *     name: "Errors",
 *     owner: "",
 *     refreshTime: 60,
 *     schemaVersion: 2,
 *     timeWindowStart: "qr-now-24h",
 *     timeWindowEnd: "qr-now",
 *     charts: [errors],
 *     layout: [{ i: errors.id, x: 0, y: 0, w: 12, h: 6 } satisfies LayoutCell],
 *   },
 * });
 * ```
 *
 * **Example:** Compare to last 24h
 * ```typescript
 * yield* Axiom.Dashboard("compare", {
 *   dashboard: {
 *     name: "Compare vs yesterday",
 *     owner: "",
 *     refreshTime: 300,
 *     schemaVersion: 2,
 *     timeWindowStart: "qr-now-1h",
 *     timeWindowEnd: "qr-now",
 *     against: "-1d",            // overlay the same window from 24h ago
 *     charts: [],
 *     layout: [],
 *   },
 * });
 * ```
 *
 * ### Looking up an existing dashboard
 * `Dashboard.lookup` references a dashboard Alchemy doesn't manage (created in
 * the Axiom console or by another stack). It is read during plan/deploy,
 * never created, updated or deleted.
 *
 * **Example:** Reference an existing dashboard
 * ```typescript
 * const ref = Axiom.Dashboard.lookup({ uid: "abc123" });
 * ```
 *
 * @resource
 * @product Dashboard
 */
export const Dashboard = Resource<Dashboard>("Axiom.Dashboard");

export const DashboardProvider = () =>
  Provider.effect(
    Dashboard,
    Effect.gen(function* () {
      const create = yield* Axiom.createDashboard;
      const update = yield* Axiom.updateDashboard;
      const get = yield* Axiom.getDashboard;
      const del = yield* Axiom.deleteDashboard;
      const listAll = yield* Axiom.listDashboards;

      const toAttrsFromCreate = (envelope: Axiom.DashboardWriteResponse) => ({
        uid: envelope.dashboard.uid,
        id: envelope.dashboard.id,
        createdAt: envelope.dashboard.createdAt ?? undefined,
        createdBy: envelope.dashboard.createdBy ?? undefined,
        updatedAt: envelope.dashboard.updatedAt ?? undefined,
        updatedBy: envelope.dashboard.updatedBy ?? undefined,
        dashboard: envelope.dashboard.dashboard,
      });
      const toAttrsFromGet = (current: Axiom.DashboardResource) => ({
        uid: current.uid,
        id: current.id,
        createdAt: current.createdAt ?? undefined,
        createdBy: current.createdBy ?? undefined,
        updatedAt: current.updatedAt ?? undefined,
        updatedBy: current.updatedBy ?? undefined,
        dashboard: current.dashboard,
      });

      // Dashboard uids are server-assigned and names aren't unique, so the
      // only way to find a dashboard we have no state for is by name. Adopt
      // only an unambiguous match; with two or more, leave it to a create.
      // Dashboards carry no ownership marker, so a match is `Unowned` and
      // taking it over needs `--adopt`.
      const findByName = (name: string) =>
        listAll({}).pipe(
          Effect.map((all) => all.filter((d) => d.dashboard?.name === name)),
          Effect.map((matches) =>
            matches.length === 1 ? Unowned(toAttrsFromGet(matches[0]!)) : undefined,
          ),
        );

      return {
        stables: ["uid", "id", "createdAt", "createdBy"],
        reconcile: Effect.fn(function* ({ news, output }) {
          // Observe — `uid` is server-assigned at create time. We probe
          // Axiom for the dashboard via the cached uid; treat NotFound
          // (deleted out-of-band) as "no observed state" so we converge
          // by re-creating.
          const observed = output?.uid
            ? yield* get({ uid: output.uid }).pipe(
                Effect.catchTag("NotFound", () => Effect.undefined),
              )
            : undefined;

          // Ensure — POST mints a new dashboard with a fresh uid.
          if (observed === undefined) {
            return toAttrsFromCreate(yield* create(news));
          }

          // Sync — `overwrite: true` short-circuits Axiom's optimistic-
          // concurrency check (otherwise the API requires the caller to
          // echo back the server-side `version`, which we don't track).
          return toAttrsFromCreate(yield* update({ ...news, uid: observed.uid, overwrite: true }));
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ uid: output.uid }).pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        lookup: Effect.fn(function* ({ uid }) {
          return yield* get({ uid }).pipe(
            Effect.map(toAttrsFromGet),
            Effect.catchTag("NotFound", () => Effect.undefined),
          );
        }),

        // The dashboard's name is its identity until it has a uid; check it as
        // soon as it resolves, even while chart queries are still unresolved.
        observe: Effect.fn(function* ({ news }) {
          const name = news.dashboard?.name;
          if (!isResolved(name)) return Unresolved;
          return name ? yield* findByName(name) : undefined;
        }),
        read: Effect.fn(function* ({ output, olds }) {
          if (!output?.uid)
            return olds?.dashboard?.name ? yield* findByName(olds.dashboard.name) : undefined;
          return yield* get({ uid: output.uid }).pipe(
            Effect.map(toAttrsFromGet),
            Effect.catchTag("NotFound", () => Effect.undefined),
          );
        }),
        // Enumerate every dashboard visible to the caller. `GET /v2/dashboards`
        // returns the full collection in one response (no pagination wrapper);
        // each item carries the same shape as `getDashboard`, so we map through
        // the shared `toAttrsFromGet` hydrator to produce the exact `read`
        // Attributes shape.
        list: () => listAll({}).pipe(Effect.map((dashboards) => dashboards.map(toAttrsFromGet))),
      };
    }),
  );
