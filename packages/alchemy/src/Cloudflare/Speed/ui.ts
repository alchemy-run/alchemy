import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { TestSchedule } from "./TestSchedule.ts";

/**
 * Dashboard UI providers for Cloudflare Speed resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const TestScheduleUI = UIProvider.succeed<TestSchedule>(
  "Cloudflare.Speed.TestSchedule",
  {
    displayName: "Speed Test Schedule",
    icon: "gauge",
    color: "#F6821F",
    category: "observability",
    summary: (ctx) => ctx.attrs?.url,
    link: (ctx) =>
      ctx.attrs?.url === undefined ? undefined : `https://${ctx.attrs.url}`,
    facts: (ctx) => [
      { label: "url", value: ctx.attrs?.url, mono: true, copy: true },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "region", value: ctx.attrs?.region },
      { label: "frequency", value: ctx.attrs?.frequency },
    ],
  },
);

export const ui = () => Layer.mergeAll(TestScheduleUI);
