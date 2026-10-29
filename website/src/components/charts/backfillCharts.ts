import type { LineChartSpec } from "./lineChart.ts";

/**
 * Backfill scaling, measured on Cloudflare by
 * `packages/integration-tests/test/Cloudflare/Domain/CatchUp.bench.test.ts`
 * (2026-10-29). Cost is at Workers Paid rates, before the monthly allowance:
 * requests, duration, and rows written and read.
 */
export const backfillCharts = {
  timeByWidth: {
    title: "How long the deploy waits, by number of accounts",
    x: { label: "Accounts, 10 deposits each", ticks: [1_000, 10_000, 100_000], log: true },
    y: { label: "Minutes", ticks: [0, 5, 10, 15, 20] },
    unit: "min",
    series: [
      {
        name: "A view per account",
        points: [
          [1_000, 1.9],
          [10_000, 5.9],
          [100_000, 17.5],
        ],
      },
    ],
  },
  timeByDepth: {
    title: "How long the deploy waits, by events behind one key",
    x: { label: "Events behind the key", ticks: [1_000, 10_000, 100_000], log: true },
    y: { label: "Minutes", ticks: [0, 2, 4, 6, 8] },
    unit: "min",
    series: [
      {
        name: "One account's summary",
        points: [
          [1_000, 0.2],
          [10_000, 0.6],
          [100_000, 5.9],
        ],
      },
      { name: "A bank-wide total, fed by 100 accounts", points: [[10_000, 1.9]] },
    ],
  },
  costByEvents: {
    title: "What a backfill costs per million events",
    x: { label: "Events in the history", ticks: [1_000, 10_000, 100_000, 1_000_000], log: true },
    y: { label: "Dollars per million events", ticks: [0, 5, 10, 15, 20] },
    unit: "",
    prefix: "$",
    series: [
      {
        name: "A view per account",
        points: [
          [10_000, 14.4],
          [100_000, 13.1],
          [1_000_000, 16.1],
        ],
      },
      {
        name: "One account's summary",
        points: [
          [1_000, 5.6],
          [10_000, 5.1],
          [100_000, 5.1],
        ],
      },
      { name: "A bank-wide total", points: [[10_000, 11.1]] },
    ],
  },
} satisfies Record<string, LineChartSpec>;

export type BackfillChart = keyof typeof backfillCharts;
