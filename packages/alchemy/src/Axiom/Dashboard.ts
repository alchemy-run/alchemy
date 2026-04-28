import * as Operations from "@distilled.cloud/axiom/Operations";
import * as Effect from "effect/Effect";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

export type DashboardProps = Operations.CreateDashboardInput;

export type Dashboard = Resource<
  "Axiom.Dashboard",
  DashboardProps,
  {
    /** Stable Axiom dashboard `uid` (used as the path identifier). */
    uid: string;
    id: string;
    createdAt: string;
    createdBy: string;
    updatedAt: string;
    updatedBy: string;
    /** The full dashboard document as returned by Axiom. */
    dashboard: Operations.CreateDashboardOutput["dashboard"]["dashboard"];
  },
  never,
  Providers
>;

/**
 * An Axiom dashboard — a named, layout-driven collection of charts. Each
 * dashboard takes a full document (`charts` + `layout` array of grid cells +
 * `timeWindow` + `refreshTime`) at version `schemaVersion: 2`. Charts are
 * passed through opaquely (`Schema.Unknown`); copy them from an existing
 * dashboard JSON export rather than authoring from scratch.
 *
 * The path identifier is `uid` (auto-assigned by Axiom). `id` is also
 * exposed as an output but the API uses `uid` everywhere.
 *
 * @see https://axiom.co/docs/query-data/dashboards
 *
 * @section Creating a Dashboard
 * @example Minimal empty dashboard
 * ```typescript
 * yield* Axiom.Dashboard("ops", {
 *   dashboard: {
 *     name: "Ops Overview",
 *     owner: "team:ops",
 *     description: "Top-level service health",
 *     charts: [],
 *     layout: [],
 *     refreshTime: 60,           // seconds: 15 | 60 | 300
 *     schemaVersion: 2,
 *     timeWindowStart: "now-1h",
 *     timeWindowEnd: "now",
 *   },
 * });
 * ```
 *
 * @example One-chart dashboard
 * ```typescript
 * yield* Axiom.Dashboard("errors", {
 *   dashboard: {
 *     name: "Errors",
 *     owner: "team:sre",
 *     refreshTime: 60,
 *     schemaVersion: 2,
 *     timeWindowStart: "now-24h",
 *     timeWindowEnd: "now",
 *     charts: [
 *       // Paste an exported chart JSON here. Authoring by hand is brittle —
 *       // the recommended workflow is to build the chart in the Axiom UI,
 *       // export the dashboard, and copy the chart object across.
 *       { ...chartJson },
 *     ],
 *     layout: [
 *       { i: chartJson.id, x: 0, y: 0, w: 12, h: 6 },
 *     ],
 *   },
 * });
 * ```
 *
 * @example Compare to last 24h
 * ```typescript
 * yield* Axiom.Dashboard("compare", {
 *   dashboard: {
 *     name: "Compare vs yesterday",
 *     owner: "team:product",
 *     refreshTime: 300,
 *     schemaVersion: 2,
 *     timeWindowStart: "now-1h",
 *     timeWindowEnd: "now",
 *     against: "-1d",            // overlay the same window from 24h ago
 *     charts: [],
 *     layout: [],
 *   },
 * });
 * ```
 */
export const Dashboard = Resource<Dashboard>("Axiom.Dashboard");

export const DashboardProvider = () =>
  Provider.effect(
    Dashboard,
    Effect.gen(function* () {
      const create = yield* Operations.createDashboard;
      const update = yield* Operations.updateDashboard;
      const get = yield* Operations.getDashboard;
      const del = yield* Operations.deleteDashboard;

      const toAttrsFromCreate = (envelope: Operations.CreateDashboardOutput) => ({
        uid: envelope.dashboard.uid,
        id: envelope.dashboard.id,
        createdAt: envelope.dashboard.createdAt,
        createdBy: envelope.dashboard.createdBy,
        updatedAt: envelope.dashboard.updatedAt,
        updatedBy: envelope.dashboard.updatedBy,
        dashboard: envelope.dashboard.dashboard,
      });
      const toAttrsFromGet = (current: Operations.GetDashboardOutput) => ({
        uid: current.uid,
        id: current.id,
        createdAt: current.createdAt,
        createdBy: current.createdBy,
        updatedAt: current.updatedAt,
        updatedBy: current.updatedBy,
        dashboard: current.dashboard,
      });

      return {
        stables: ["uid", "id", "createdAt", "createdBy"],
        create: Effect.fn(function* ({ news }) {
          return toAttrsFromCreate(yield* create(news));
        }),
        update: Effect.fn(function* ({ news, output }) {
          return toAttrsFromCreate(
            yield* update({ ...news, uid: output.uid }),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ uid: output.uid }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.uid) return undefined;
          return yield* get({ uid: output.uid }).pipe(
            Effect.map(toAttrsFromGet),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );
