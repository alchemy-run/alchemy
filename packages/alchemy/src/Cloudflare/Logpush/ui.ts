import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Job } from "./Job.ts";

/**
 * Dashboard UI providers for Cloudflare Logpush resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const JobUI = UIProvider.succeed<Job>("Cloudflare.Logpush.Job", {
  displayName: "Logpush Job",
  icon: "file-output",
  color: "#F6821F",
  category: "observability",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "job id", value: ctx.attrs?.jobId, mono: true, copy: true },
    { label: "dataset", value: ctx.attrs?.dataset },
    { label: "kind", value: ctx.attrs?.kind || undefined },
    {
      label: "scope",
      value:
        ctx.attrs?.zoneId !== undefined
          ? `zone ${ctx.attrs.zoneId}`
          : ctx.attrs?.accountId !== undefined
            ? "account"
            : undefined,
    },
    { label: "enabled", value: ctx.attrs?.enabled },
    { label: "destination", value: ctx.props?.destinationConf, mono: true },
    { label: "last error", value: ctx.attrs?.lastError },
  ],
});

export const ui = () => Layer.mergeAll(JobUI);
