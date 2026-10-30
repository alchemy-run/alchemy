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
    y: { label: "Seconds", ticks: [0, 300, 600, 900, 1200] },
    unit: "s",
    series: [
      {
        name: "Accounts route their own history",
        points: [
          [1_000, 112],
          [10_000, 353],
          [100_000, 1048],
        ],
      },
      {
        name: "Keys read their account's log",
        points: [
          [1_000, 14],
          [10_000, 22],
          [100_000, 144],
        ],
      },
    ],
  },
  timeByDepth: {
    title: "How long the deploy waits, by events behind one key",
    x: { label: "Events behind the key", ticks: [1_000, 10_000, 100_000], log: true },
    y: { label: "Seconds", ticks: [0, 100, 200, 300, 400] },
    unit: "s",
    series: [
      {
        name: "Accounts route their own history",
        points: [
          [1_000, 13],
          [10_000, 39],
          [100_000, 355],
        ],
      },
      {
        name: "Keys read their account's log",
        points: [
          [1_000, 15],
          [10_000, 27],
        ],
      },
    ],
  },
  costByEvents: {
    title: "What a backfill costs per million events",
    x: { label: "Events in the history", ticks: [10_000, 100_000, 1_000_000], log: true },
    y: { label: "Dollars per million events", ticks: [0, 5, 10, 15, 20] },
    unit: "",
    prefix: "$",
    series: [
      {
        name: "Accounts route their own history",
        points: [
          [10_000, 14.4],
          [100_000, 13.1],
          [1_000_000, 16.1],
        ],
      },
      {
        name: "Keys read their account's log",
        points: [
          [10_000, 10.9],
          [1_000_000, 11.2],
        ],
      },
    ],
  },
} satisfies Record<string, LineChartSpec>;

export type BackfillChart = keyof typeof backfillCharts;
