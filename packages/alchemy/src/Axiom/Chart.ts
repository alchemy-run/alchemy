/**
 * Typed view of the Axiom dashboard chart-JSON subset.
 *
 * Axiom's `CreateDashboardInput` declares
 * `dashboard.charts: ReadonlyArray<unknown>` (see
 * `@distilled.cloud/axiom/.../v2/createDashboard.ts`); these
 * interfaces give callers compile-time safety when building the
 * payload by hand.
 *
 * `chart.id` is a free-form string the author picks — Axiom
 * doesn't validate the format. It joins to the matching
 * `LayoutCell.i` in `dashboard.layout`.
 */

/**
 * Axiom-validated chart kinds. Discovered by probing
 * `POST /v2/dashboards`: anything else returns
 * `dashboard validation failed at [charts N type]: Invalid input`.
 */
export type ChartKind =
  | "TimeSeries"
  | "Table"
  | "Pie"
  | "Statistic"
  | "Heatmap"
  | "LogStream"
  | "Note";

/**
 * Minimum chart payload Axiom's `POST /v2/dashboards` accepts.
 * Any unknown keys (e.g. `dataset`, `description`) trigger
 * `Unrecognized keys: "<name>"`, so this struct is intentionally
 * narrow. The dataset is implicit via the APL query.
 */
export interface BaseChart {
  readonly id: string;
  readonly name: string;
  readonly type: ChartKind;
  readonly query: { readonly apl: string };
}

export interface TimeSeriesChart extends BaseChart {
  readonly type: "TimeSeries";
}

export interface TableChart extends BaseChart {
  readonly type: "Table";
}

export interface PieChart extends BaseChart {
  readonly type: "Pie";
}

export interface StatisticChart extends BaseChart {
  readonly type: "Statistic";
}

export interface HeatmapChart extends BaseChart {
  readonly type: "Heatmap";
}

export interface LogStreamChart extends BaseChart {
  readonly type: "LogStream";
}

export interface NoteChart extends BaseChart {
  readonly type: "Note";
}

export type Chart =
  | TimeSeriesChart
  | TableChart
  | PieChart
  | StatisticChart
  | HeatmapChart
  | LogStreamChart
  | NoteChart;

/**
 * Mirrors Axiom's `CreateDashboardInput.dashboard.layout` cell schema.
 * `i` references a chart by its `id`.
 */
export interface LayoutCell {
  readonly i: string;
  readonly x: number;
  readonly y: number | null;
  readonly w: number;
  readonly h: number;
  readonly minW?: number;
  readonly minH?: number;
  readonly maxW?: number;
  readonly maxH?: number;
  readonly static?: boolean;
}
