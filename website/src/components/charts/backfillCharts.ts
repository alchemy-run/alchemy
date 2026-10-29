import type { LineChartSpec } from "./lineChart.ts";

/**
 * Backfill scaling, from the simulator in
 * `packages/integration-tests/test/Domain/Backfill.bench.test.ts` (the same
 * protocol code, with a 10 ms round trip, 50 ms alarms and 1 ms per event).
 * Rows are the protocol's own, not counting the view writing its state.
 */
export const backfillCharts = {
  timeByWidth: {
    title: "Time as instances grow (10 events each)",
    x: { label: "Instances", ticks: [100, 1_000, 10_000], log: true },
    y: { label: "Seconds", ticks: [0, 10, 20, 30, 40, 50] },
    unit: "s",
    series: [
      {
        name: "Keyed by its aggregate",
        points: [
          [100, 5.6],
          [1_000, 5.9],
          [10_000, 7.5],
        ],
      },
      {
        name: "100 instances per key",
        points: [
          [1_000, 5.8],
          [10_000, 7.1],
        ],
      },
      {
        name: "One key for all",
        points: [
          [100, 5.6],
          [1_000, 40.3],
        ],
      },
    ],
  },
  timeByDepth: {
    title: "Time as one key's history grows",
    x: { label: "Events behind the key", ticks: [10, 100, 1_000, 10_000, 100_000], log: true },
    y: { label: "Seconds", ticks: [0, 20, 40, 60, 80, 100] },
    unit: "s",
    series: [
      {
        name: "From one instance",
        points: [
          [10, 5.4],
          [100, 5.4],
          [1_000, 5.4],
          [10_000, 13.1],
        ],
      },
      {
        name: "From 100 instances",
        points: [
          [1_000, 5.6],
          [10_000, 12.7],
          [100_000, 91.7],
        ],
      },
    ],
  },
  costByWidth: {
    title: "Cost per event as instances grow (10 events each)",
    x: { label: "Instances", ticks: [100, 1_000, 10_000], log: true },
    y: { label: "Rows written per event", ticks: [0, 4, 8, 12] },
    unit: "rows",
    series: [
      {
        name: "Keyed by its aggregate",
        points: [
          [100, 5.3],
          [1_000, 4.1],
          [10_000, 3.8],
        ],
      },
      {
        name: "Through keyOf",
        points: [
          [100, 9.7],
          [1_000, 8.5],
          [10_000, 8.2],
        ],
      },
    ],
  },
  costByDepth: {
    title: "Cost per event as histories grow (1,000 instances)",
    x: { label: "Events per instance", ticks: [1, 10, 100], log: true },
    y: { label: "Rows written per event", ticks: [0.1, 1, 10, 100], log: true },
    unit: "rows",
    series: [
      {
        name: "Keyed by its aggregate",
        points: [
          [1, 41],
          [10, 4.1],
          [100, 0.41],
        ],
      },
      {
        name: "Through keyOf",
        points: [
          [1, 49],
          [10, 8.5],
          [100, 4.5],
        ],
      },
    ],
  },
} satisfies Record<string, LineChartSpec>;

export type BackfillChart = keyof typeof backfillCharts;
